import React, { useState, useEffect, useRef, useCallback } from 'react';
import Draggable from 'react-draggable';
import { ResizableBox } from 'react-resizable';
import ChatCorner from '../../img/chat_corner.svg';
import Settings from './settings';
import ChatInput from './input';
import Channels, { DEFAULT_CHANNEL, SYSTEM_CHANNEL, applyChannel, channelForMessage } from './channels';
import { enterOpensChat, widgetTypes } from './enterFocus';
import { replaceIfMoreThan20 } from '../../utils/replaceIfMoreThan20';
import { useUiSettings, announceUiSettings, CHAT_EVENT } from '../../utils/uiSettings';

import './styles.scss';
const MAX_LENGTH = 2000;
const TIME_LIMIT = 1; // Seconds
const SHOUT_LIMIT = 180; // Seconds
const MAX_LINES = 10;
const MAX_SHOUT_LENGTH = 100;
const MAX_HISTORY_LENGTH = 20;

const SHOUTREGEXP = /№(.*?)№/gi;
// The injected chat JS colours a known name with this (chatService NAME); the book lettering sets names in Futura
const NAME_COLOR = '#fbf724';
// The client's hide-chat key (F3, Settings) sets window.__dboChatHidden and fires this
const HIDDEN_EVENT = 'dbo:chatHidden';

// Chat settings (font size, transparency, lock, highlights, nametag toggles, window pos/size) persist via window.__alduinakChatSettings: the client injects saved values on mount and writes changes under Data/Platform since localStorage/CEF cache do not survive a relaunch
const loadChatSettings = () => {
  try { return window.__alduinakChatSettings || {}; }
  catch (e) { return {}; }
};
const persistChatSettings = (patch) => {
  try {
    const next = Object.assign(loadChatSettings(), patch);
    window.__alduinakChatSettings = next;
    if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) {
      window.skyrimPlatform.sendMessage('cef::chat:saveSettings', JSON.stringify(next));
    }
  } catch (e) {}
};

const Chat = (props) => {
  // Load the persisted settings once; used to seed the state below.
  const savedRef = useRef();
  if (savedRef.current === undefined) savedRef.current = loadChatSettings();
  const saved = savedRef.current;

  const [input, updateInput] = useState('');
  const [isInputFocus, changeInputFocus] = useState(false);
  const [hideNonRP, changeNonRPHide] = useState(false);
  const [isSettingsOpened, setSettingsOpened] = useState(false);
  const [lockChat, setLockChat] = useState(saved.lockChat != null ? saved.lockChat : false);
  const [chatTransparency, setChatTransparency] = useState(saved.chatTransparency != null ? saved.chatTransparency : 25);
  const [customHighlights, setCustomHighlights] = useState(saved.customHighlights != null ? saved.customHighlights : '');
  const [channel, setChannel] = useState(DEFAULT_CHANNEL);
  const [fontSize, setFontSize] = useState(saved.fontSize != null ? saved.fontSize : 16);
  const [fadeSeconds, setFadeSeconds] = useState(saved.fadeSeconds != null ? saved.fadeSeconds : 10);
  const [hidePlayerNames, setHidePlayerNames] = useState(saved.hidePlayerNames != null ? saved.hidePlayerNames : false);
  const [showFormIds, setShowFormIds] = useState(saved.showFormIds != null ? saved.showFormIds : true);
  const [idle, setIdle] = useState(false);
  // F3, Settings, Interface: Always (the frame fades, text stays), Fade when idle (text too), Hidden until T
  const ui = useUiSettings();
  const [keyHidden, setKeyHidden] = useState(() => !!window.__dboChatHidden);
  const [veilAt, setVeilAt] = useState(0);
  const idleTimerRef = useRef();
  const browserFocusedRef = useRef(false);
  const placeholder = props.placeholder;
  const isInputHidden = props.isInputHidden;
  const send = props.send;
  const [lastSendInputText, setLastSendInputText] = useState(0);

  const [doesIncludeShout, setIncludeShout] = useState(false);

  const [shoutLength, setShoutLength] = useState(0);

  const inputRef = useRef();

  const chatRef = useRef();

  const isReset = useRef(true);

  const shoutReset = useRef(true);

  const messagesHistory = useRef([]);

  const currentMessageInHistory = useRef(-1);

  const writtenMessage = useRef('');
  
  // The System tab is a read-only feed of notifications - you can't type into it.
  const isSystemTab = channel === SYSTEM_CHANNEL;

  const hasUnreadPersonal = window.chatMessages.some((m) => m.channel === 'personal' && !m.read);
  const hasUnreadSystem = window.chatMessages.some((m) => m.channel === SYSTEM_CHANNEL && !m.read);
  useEffect(() => {
    if (channel === 'personal') {
      window.chatMessages.forEach((m) => { if (m.channel === 'personal') m.read = true; });
    }
    if (channel === SYSTEM_CHANNEL) {
      window.chatMessages.forEach((m) => { if (m.channel === SYSTEM_CHANNEL) m.read = true; });
    }
  }, [channel, props.messages]);

  const handleScroll = () => {
    if (chatRef.current) {
      const el = chatRef.current;
      // Keep following new messages while we're at (or near) the bottom.
      window.needToScroll = (el.scrollHeight - el.offsetHeight - el.scrollTop < 40);
    }
  };

  const setEndOfContenteditable = (elem) => {
    const sel = window.getSelection();
    sel.selectAllChildren(elem);
    sel.collapseToEnd();
  };

  const addMessageToHistory = (message) => {
    // The same line sent again stays one entry, so Up does not step through repeats
    if (messagesHistory.current[0] !== message) messagesHistory.current = [message, ...messagesHistory.current];
    if (messagesHistory.current.length > MAX_HISTORY_LENGTH) {
      messagesHistory.current = messagesHistory.current.slice(0, MAX_HISTORY_LENGTH);
    }
    currentMessageInHistory.current = -1;
    writtenMessage.current = '';
  };

  // Returns the keyboard to the game
  const releaseFocus = () => {
    inputRef.current?.blur();
    if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) {
      window.skyrimPlatform.sendMessage('cef::browser:unfocus');
    }
  };

  const sendMessage = useCallback((text) => {
    // The System tab takes /commands, so the list a message showed stays in view while you type one (athny, 2026-09-25,
    // "QOL System Chat"); plain text typed there is said in Local, as before, and the tab follows it.
    const shout = text.match(SHOUTREGEXP);
    const shoutLen = shout
      ? shout.reduce((acc, text) => {
        acc += text.length;
        return acc;
      }, 0)
      : 0;
    if (text !== '' && text.length <= MAX_LENGTH && isReset.current && shoutLen <= MAX_SHOUT_LENGTH && (shoutLen === 0 || shoutReset.current)) {
      if (send !== undefined) {
        const message = replaceIfMoreThan20(text.trim(), '\n', '', MAX_LINES);
        const applied = applyChannel(message, channel);
        send(applied);
        addMessageToHistory(message);
        // Follow the message into its tab (e.g. "/ooc hi" -> Global).
        const target = channelForMessage(applied);
        if (target) setChannel(target);
      }
      isReset.current = false;
      updateInput('');
      inputRef.current.textContent = '';
      releaseFocus();
      if (shout) {
        shoutReset.current = false;
        setTimeout(() => {
          shoutReset.current = true;
        }, 1000 * SHOUT_LIMIT);
        setIncludeShout(false);
        setShoutLength(0);
      }
    }
  }, [send, updateInput, input, channel, isReset.current, shoutReset.current, shoutLength, doesIncludeShout]);

  useEffect(() => {
    window.needToScroll = true;
    const interval = setInterval(() => {
      isReset.current = true;
    }, 1000 * TIME_LIMIT);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const node = inputRef.current;
    const listener = (event) => {
      // Imitate message sending on Enter press; an empty line hands the keyboard back
      if (event.code === 'Enter' && !event.shiftKey && inputRef.current) {
        event.preventDefault();
        if ((input || '').trim() === '') releaseFocus();
        else sendMessage(input);
      }
      if (event.key === 'Escape') releaseFocus();
      // Up and Down step through what you sent before while the text is one line or a recalled entry; Ctrl+Up/Down on any line
      const historyKey = !event.shiftKey && !event.altKey &&
        (event.ctrlKey || currentMessageInHistory.current >= 0 || !(input || '').trim().includes('\n'));
      if (event.key === 'ArrowUp' && historyKey && messagesHistory.current.length > 0) {
        event.preventDefault();
        if (currentMessageInHistory.current === -1) {
          writtenMessage.current = input;
        }
        if (currentMessageInHistory.current + 1 < messagesHistory.current.length) {
          currentMessageInHistory.current = currentMessageInHistory.current + 1;
          updateInput(messagesHistory.current[currentMessageInHistory.current]);
          inputRef.current.innerText = messagesHistory.current[currentMessageInHistory.current];
          setEndOfContenteditable(inputRef.current);
        }
      }
      if (event.key === 'ArrowDown' && historyKey && currentMessageInHistory.current >= 0) {
        event.preventDefault();
        if (currentMessageInHistory.current === 0) {
          updateInput(writtenMessage.current);
          inputRef.current.innerText = writtenMessage.current;
          setEndOfContenteditable(inputRef.current);
          currentMessageInHistory.current = -1;
        } else {
          currentMessageInHistory.current = currentMessageInHistory.current - 1;
          updateInput(messagesHistory.current[currentMessageInHistory.current]);
          inputRef.current.innerText = messagesHistory.current[currentMessageInHistory.current];
          setEndOfContenteditable(inputRef.current);
        }
      }
    };
    node?.addEventListener('keydown', listener);
    return () => node?.removeEventListener('keydown', listener);
  }, [inputRef.current, input, sendMessage]);

  useEffect(() => {
    if (inputRef !== undefined && inputRef.current !== undefined && !isInputHidden) {
      inputRef.current.focus();
    }
  }, [isInputHidden]);

  const focusInput = () => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      setEndOfContenteditable(el);
    }
  };

  // Behavior for T button (activate chat)
  useEffect(() => {
    // Enter and T both focus chat in the tab that is showing; the System tab takes /commands
    const onBrowserFocused = () => {
      browserFocusedRef.current = true;
      bumpIdle();
      if (isInputHidden) return;
      focusInput();
      // The page may not hold the keyboard the instant it gets it; T already retries a frame later
      requestAnimationFrame(() => { if (document.activeElement !== inputRef.current) focusInput(); });
    };
    // The dedicated chat key always lands in the Local tab
    const onChatKeyFocused = () => {
      if (isInputHidden) return;
      setChannel(DEFAULT_CHANNEL);
      requestAnimationFrame(focusInput);
    };
    window.addEventListener('skymp5-client:browserFocused', onBrowserFocused);
    window.addEventListener('skymp5-client:chatKeyFocused', onChatKeyFocused);
    return () => {
      window.removeEventListener('skymp5-client:browserFocused', onBrowserFocused);
      window.removeEventListener('skymp5-client:chatKeyFocused', onChatKeyFocused);
    };
  }, [isInputHidden, isSystemTab]);

  // Enter with nothing focused in the page: the browser already held the keyboard, so the game never saw it
  useEffect(() => {
    const onKey = (event) => {
      let widgets = [];
      try { widgets = window.skyrimPlatform && window.skyrimPlatform.widgets ? window.skyrimPlatform.widgets.get() : []; } catch (e) { widgets = []; }
      if (isInputHidden || !enterOpensChat(event, document, widgets)) return;
      event.preventDefault();
      browserFocusedRef.current = true;
      bumpIdle();
      focusInput();
      try {
        if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) window.skyrimPlatform.sendMessage('chat:enterUnfocused', widgetTypes(widgets));
      } catch (e) { /* the diagnostic is optional */ }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isInputHidden]);

  useEffect(() => {
    const onUnfocused = () => {
      browserFocusedRef.current = false;
      bumpIdle();
      setSettingsOpened(false);
    };
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, []);

  // Idle fade: the chrome melts away after fadeSeconds of no activity (text stays).
  const fadeSecondsRef = useRef(fadeSeconds);
  fadeSecondsRef.current = fadeSeconds;
  const bumpIdle = () => {
    setIdle(false);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = undefined;
    if (fadeSecondsRef.current > 0 && !browserFocusedRef.current) {
      idleTimerRef.current = setTimeout(() => setIdle(true), fadeSecondsRef.current * 1000);
    }
  };
  useEffect(() => {
    bumpIdle();
    return () => { if (idleTimerRef.current) clearTimeout(idleTimerRef.current); };
  }, [fadeSeconds]);

  const prevMessageCountRef = useRef(window.chatMessages.length);
  useEffect(() => {
    // Follow new messages to the bottom (chatRef is the scrolling list).
    if (window.needToScroll && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
    if (isInputFocus && inputRef !== undefined && inputRef.current !== undefined) {
      inputRef.current.focus();
    }
    bumpIdle();
    // Incoming system messages and PMs pull their tab into focus (never mid-typing)
    const prevCount = prevMessageCountRef.current;
    prevMessageCountRef.current = window.chatMessages.length;
    if (!isInputFocus && window.chatMessages.length > prevCount) {
      const fresh = window.chatMessages.slice(prevCount);
      if (fresh.some((m) => m.channel === SYSTEM_CHANNEL)) {
        setChannel(SYSTEM_CHANNEL);
      } else if (fresh.some((m) => m.channel === 'personal')) {
        setChannel('personal');
      }
    }
  }, [props.messages]);

  // F3, Settings changes the chat's own values; they are saved by the effect below as if set here
  useEffect(() => {
    const set = { fontSize: setFontSize, chatTransparency: setChatTransparency, customHighlights: setCustomHighlights, fadeSeconds: setFadeSeconds,
      hidePlayerNames: setHidePlayerNames, showFormIds: setShowFormIds, lockChat: setLockChat };
    const onPatch = (e) => {
      const patch = (e && e.detail) || {};
      for (const k of Object.keys(set)) if (patch[k] !== undefined) set[k](patch[k]);
    };
    window.addEventListener(CHAT_EVENT, onPatch);
    // The saved file arrived with this mount: anything drawn before it (the HUD) reads it again
    announceUiSettings();
    const onHidden = () => setKeyHidden(!!window.__dboChatHidden);
    window.addEventListener(HIDDEN_EVENT, onHidden);
    return () => { window.removeEventListener(CHAT_EVENT, onPatch); window.removeEventListener(HIDDEN_EVENT, onHidden); };
  }, []);

  // Hidden until T, and the hide-chat key: shown while the chat input has the keyboard, and fadeSeconds after it
  // leaves (5 s when fade is off); opacity only, so the input can always take the keyboard
  useEffect(() => {
    if (isInputFocus) { setVeilAt(0); return undefined; }
    const after = (fadeSeconds > 0 ? fadeSeconds : 5) * 1000;
    setVeilAt(Date.now() + after);
    const t = setTimeout(() => setVeilAt(-1), after);
    return () => clearTimeout(t);
  }, [isInputFocus, fadeSeconds]);
  const veiled = (ui.chat === 'hidden' || keyHidden) && !isInputFocus && (veilAt === -1 || (veilAt > 0 && Date.now() >= veilAt));

  // Expose the player's custom highlight words to the injected chat JS (chatService).
  useEffect(() => {
    window.__alduinakCustomHighlightsRaw = customHighlights;
  }, [customHighlights]);

  // Persist the settings whenever they change so they survive a relaunch.
  useEffect(() => {
    persistChatSettings({ fontSize, chatTransparency, lockChat, customHighlights, fadeSeconds, hidePlayerNames, showFormIds });
  }, [fontSize, chatTransparency, lockChat, customHighlights, fadeSeconds, hidePlayerNames, showFormIds]);

  const handleInput = (value) => {
    updateInput(value);
    const shout = value.match(SHOUTREGEXP);
    if (shout && shout[0] !== '') {
      setIncludeShout(true);
      setShoutLength(shout.reduce((acc, text) => {
        acc += text.length;
        return acc;
      }, 0));
    } else {
      setIncludeShout(false);
      setShoutLength(0);
    }
  };

  const getMessageSpans = (message) => {
    let isNonRp = message.category === 'plain';
    const result = message.text.map(({ text, color, opacity, type }, i) => {
      if (i >= 1) {
        isNonRp = (type.includes('nonrp') && isNonRp);
      }
      const name = String(color || '').toLowerCase() === NAME_COLOR ? ' chat-name' : '';
      return <span key={`${text}_${i}`} style={{ color: `${color}`, opacity: opacity }} className={`${type.join(' ')}${name}`}>{text}</span>;
    });
    return [result, isNonRp];
  };

  const getList = () => {
    // Show only the active tab's messages; 'all' (server /system) shows everywhere; channel-less legacy messages fall back to Local.
    return window.chatMessages.filter((msg) => {
      const ch = msg.channel || 'local';
      return ch === channel || ch === 'all';
    }).map((msg, index) => {
        const result = getMessageSpans(msg);
        return (
          <div
            className={`msg ${result[1] ? 'nonrp' : ''}`}
            key={`msg-${index}`}
            style={{ marginLeft: '10px', opacity: msg.opacity }}
          >
            {result[0]}
          </div>
        );
      });
  };
  return (
    <div className='fullPage'>
      <Draggable
        handle='.chat-drag-bar'
        disabled={lockChat}
        bounds={'.fullPage'}
        defaultPosition={saved.pos || undefined}
        onStop={(e, data) => persistChatSettings({ pos: { x: data.x, y: data.y } })}
      >
        <div id='chat' className={[idle ? 'chat-idle' : '', `chat-mode-${ui.chat}`, `chat-lettering-${ui.chatLettering}`, veiled ? 'chat-veiled' : ''].filter(Boolean).join(' ')} onMouseEnter={() => bumpIdle()} onMouseMove={() => { if (idle) bumpIdle(); }} style={{ '--chat-bg-alpha': (100 - chatTransparency) / 100 }}>
          <div className="chat-main">
            <div className='chat-header'>
              {!lockChat && <div className='chat-drag-bar' title='Drag to move chat' />}
            </div>
            <ResizableBox
              width={saved.width != null ? saved.width : 640}
              height={saved.height != null ? saved.height : 320}
              maxConstraints={[1000, 1100]}
              minConstraints={[320, 320]}
              axis={'both'}
              onResizeStop={(e, data) => persistChatSettings({ width: data.size.width, height: data.size.height })}
              handle={
                 (!isInputHidden && !lockChat) &&
                 <div className='chat-corner'>
                   <img src={ChatCorner} />
                 </div>
              }
              resizeHandles={(!isInputHidden && !lockChat) ? ['se'] : []}
              className={`chat-resizable ${hideNonRP ? 'hideNonRP' : ''}`}
              id='handle'
            >
              <div className='chat-body'>
                <div className='chat-list' style={{ fontSize }} ref={chatRef} onScroll={(e) => handleScroll()}>
                  {getList()}
                </div>
                {
                  isInputHidden
                    ? <div style={{ height: '100px' }} />
                    : (
                      <div className='input'>
                        <div className='chat-tabs-row'>
                          <Channels
                            active={channel}
                            unread={{ personal: hasUnreadPersonal, system: hasUnreadSystem }}
                            onSelect={(id) => {
                              setChannel(id);
                              if (inputRef.current) inputRef.current.focus();
                            }}
                          />
                          <button
                            type='button'
                            className='chat-settings-button'
                            title='Settings'
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              if (inputRef.current) inputRef.current.focus();
                              setSettingsOpened((open) => !open);
                            }}
                          >
                            {'⚙ Settings'}
                          </button>
                        </div>
                        <div className='chat-divider' />
                        <div className='chat-input'>
                          <ChatInput
                            id="chatInput"
                            className={'show'}
                            type="text"
                            placeholder={isSystemTab ? 'Type a /command here; other text goes to Local' : (placeholder !== undefined ? placeholder : '')}
                            onChange={(value) => {
                              handleInput(value);
                              if (lastSendInputText + 1000 < Date.now()) {
                                window.skyrimPlatform.sendMessage('onInput');
                                setLastSendInputText(Date.now());
                              }
                            }}
                            onFocus={(e) => changeInputFocus(true)}
                            onBlur={(e) => changeInputFocus(false)}
                            ref={inputRef}
                            fontSize={fontSize}
                            maxLines={MAX_LINES}
                          />
                          <div className='chat-checkboxes'>
                            { !isSystemTab && doesIncludeShout &&
                              <span className={`chat-message-limit shout-limit ${shoutLength > MAX_SHOUT_LENGTH ? 'limit' : ''} text`}>{shoutLength}/{MAX_SHOUT_LENGTH}</span>
                            }
                            { !isSystemTab &&
                              <span className={`chat-message-limit ${input.length > MAX_LENGTH ? 'limit' : ''} text`}>{input.length}/{MAX_LENGTH}</span>
                            }
                          </div>
                        </div>
                      </div>
                    )
                }
              </div>
            </ResizableBox>
          </div>
        </div>
      </Draggable>
      {
        (isSettingsOpened && !isInputHidden) &&
        <Settings
          fontSize={fontSize}
          setFontSize={setFontSize}
          lockChat={lockChat}
          setLockChat={setLockChat}
          hidePlayerNames={hidePlayerNames}
          setHidePlayerNames={setHidePlayerNames}
          showFormIds={showFormIds}
          setShowFormIds={setShowFormIds}
          chatTransparency={chatTransparency}
          setChatTransparency={setChatTransparency}
          fadeSeconds={fadeSeconds}
          setFadeSeconds={setFadeSeconds}
          customHighlights={customHighlights}
          setCustomHighlights={setCustomHighlights}
          onBack={() => {
            setSettingsOpened(false);
            if (window.skyrimPlatform && window.skyrimPlatform.sendMessage) {
              window.skyrimPlatform.sendMessage('cef::browser:unfocus');
            }
          }}
        />
      }
    </div>
  );
};

export default Chat;
