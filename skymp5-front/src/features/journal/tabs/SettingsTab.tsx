import React, { useEffect, useState } from 'react';

import './SettingsTab.scss';
import { JournalTabProps, registerJournalTab } from '../tabs';
import { Picker } from '../../../components/Picker/Picker';
import {
  ChatLettering, ChatMode, UiSettings, VITALS_FADE_CHOICES, VitalsMode, VitalsStyle,
  chatSettingsFile, setChatSettings, setUiSettings, useUiSettings,
} from '../../../utils/uiSettings';

// The F3 hub's Settings tab (specs/f3-hub-design.md 3.7). Settings belong to the player's PC: nothing here is sent to
// the server but a problem report. A rail of sections on the left (General, Controls, Voice, Interface, Help); each
// section is a component registered with registerSettingsSection, so the key and voice pieces add theirs.

// What the server sends in the settings section (journal.js settingsView, plus what other modules add)
export interface SettingsSection {
  staff?: boolean;
  voiceOn?: boolean;
  nearby?: Array<{ identity: string; name: string; meters?: number }>;
  focusPeer?: string;
  section?: string;
}

export interface SettingsPartProps {
  section: SettingsSection;
  act: (event: string, ...args: unknown[]) => void;
  busy: boolean;
}

interface Part { id: string; label: string; order: number; component: React.ComponentType<SettingsPartProps>; shown?: (s: SettingsSection) => boolean }
const PARTS: Part[] = [];
const ORDER: Record<string, number> = { general: 1, controls: 2, voice: 3, interface: 4, help: 5 };
export const registerSettingsSection = (id: string, label: string, component: React.ComponentType<SettingsPartProps>, shown?: (s: SettingsSection) => boolean): void => {
  const at = PARTS.findIndex((p) => p.id === id);
  const part = { id, label, order: ORDER[id] || 9, component, shown };
  if (at >= 0) PARTS[at] = part; else PARTS.push(part);
  PARTS.sort((x, y) => x.order - y.order);
};
export const settingsSections = (): string[] => PARTS.map((p) => p.id);

// ---- small controls: a row of choices (never a native select) and a range ------------------------------------------
export function Chips<V extends string | number>({ value, options, onChange, label }: {
  value: V; options: Array<[V, string]>; onChange: (v: V) => void; label: string;
}) {
  return (
    <div className="jset__chips" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={v === value} className={'jset__chip' + (v === value ? ' jset__chip--on' : '')}
          onClick={() => { if (v !== value) onChange(v); }}>{text}</button>
      ))}
    </div>
  );
}

export const Row = ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
  <div className="jset__row">
    <div className="jset__label">
      <span>{label}</span>
      {hint ? <span className="jset__hint">{hint}</span> : null}
    </div>
    <div className="jset__control">{children}</div>
  </div>
);

export const Range = ({ value, min, max, step, onChange, format }: {
  value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string;
}) => (
  <span className="jset__range">
    <input type="range" min={min} max={max} step={step || 1} value={value}
      onChange={(e) => onChange(Number(e.target.value))} onKeyDown={(e) => e.stopPropagation()} />
    <span className="jset__range-value">{format ? format(value) : String(value)}</span>
  </span>
);

// Keys typed in a field stay out of the game and the journal's Escape; Escape leaves the field
export const stopKeys = (e: React.KeyboardEvent<HTMLElement>): void => {
  e.stopPropagation();
  if (e.key === 'Escape') { e.preventDefault(); (e.target as HTMLElement).blur(); }
};

// ---- Interface ---------------------------------------------------------------------------------------------------
const SCALES: Array<[number, string]> = [[0, 'Auto'], [1, '100%'], [1.1, '110%'], [1.25, '125%'], [1.5, '150%'], [1.75, '175%'], [2, '200%']];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const w = (): any => window;
const scaleNow = (): number => { try { const g = w().dboGetUiScale ? w().dboGetUiScale() : null; return g ? Number(g.override) || 0 : 0; } catch (e) { return 0; } };

const InterfacePart = () => {
  const ui = useUiSettings();
  const file = chatSettingsFile();
  const [scale, setScale] = useState<number>(scaleNow);
  const [chat, setChat] = useState(() => ({
    fontSize: Number(file.fontSize) || 16, chatTransparency: file.chatTransparency != null ? Number(file.chatTransparency) : 25,
    fadeSeconds: file.fadeSeconds != null ? Number(file.fadeSeconds) : 10, hidePlayerNames: file.hidePlayerNames === true,
    showFormIds: file.showFormIds !== false, customHighlights: String(file.customHighlights || ''),
  }));
  const [reset, setReset] = useState(false);
  const ui2 = (patch: Partial<UiSettings>): void => { setUiSettings(patch); };
  const chat2 = (patch: Partial<typeof chat>): void => { setChat(Object.assign({}, chat, patch)); setChatSettings(patch); };
  const pickScale = (v: number): void => {
    setScale(v);
    try { if (w().dboSetUiScaleInGame) w().dboSetUiScaleInGame(v); } catch (e) { /* the size stays */ }
  };
  const scaleOptions = SCALES.some(([v]) => v === scale) ? SCALES : SCALES.concat([[scale, `${Math.round(scale * 100)}%`]]);
  return (
    <div className="jset__part">
      <section className="jset__group">
        <h2 className="journal__heading">Size</h2>
        <Row label="Interface size" hint="Every panel and the HUD. Auto follows your screen.">
          <Picker<number> className="jset__picker" value={scale} title="Interface size" onChange={pickScale} options={scaleOptions.map(([value, label]) => ({ value, label }))} />
        </Row>
        <Row label="Panel sizes" hint="Ctrl and the mouse wheel over a panel resize it.">
          <button type="button" className="journal__button" disabled={reset}
            onClick={() => { try { if (w().dboResetPanelScales) w().dboResetPanelScales(Date.now()); } catch (e) { /* none */ } setReset(true); }}>
            {reset ? 'Every panel is back to its size' : 'Reset every panel\'s size'}
          </button>
        </Row>
      </section>
      <section className="jset__group">
        <h2 className="journal__heading">Health, magicka and stamina</h2>
        <Row label="Show the bars" hint={ui.vitals === 'fade' ? 'They come back at once when you are hit, or use stamina or magicka.' : undefined}>
          <Chips<VitalsMode> label="Show the bars" value={ui.vitals} onChange={(v) => ui2({ vitals: v })}
            options={[['always', 'Always'], ['fade', 'Fade when full'], ['hidden', 'Hidden']]} />
        </Row>
        {ui.vitals === 'fade' ? (
          <Row label="Fade after">
            <Chips<number> label="Fade after" value={ui.vitalsFadeSeconds} onChange={(v) => ui2({ vitalsFadeSeconds: v })}
              options={VITALS_FADE_CHOICES.map((n) => [n, `${n} s`] as [number, string])} />
          </Row>
        ) : null}
        <Row label="Style" hint="Quiet: thin muted bars without the glow.">
          <Chips<VitalsStyle> label="Style" value={ui.vitalsStyle} onChange={(v) => ui2({ vitalsStyle: v })} options={[['quiet', 'Quiet'], ['classic', 'Classic']]} />
        </Row>
      </section>
      <section className="jset__group">
        <h2 className="journal__heading">Chat</h2>
        <Row label="Show the chat" hint={ui.chat === 'hidden' ? 'T opens it; it goes again a moment after you finish.' : ui.chat === 'fade' ? 'The lines fade with the frame; a new line brings them back.' : 'The frame fades when idle; the lines stay.'}>
          <Chips<ChatMode> label="Show the chat" value={ui.chat} onChange={(v) => ui2({ chat: v })}
            options={[['always', 'Always'], ['fade', 'Fade when idle'], ['hidden', 'Hidden until T']]} />
        </Row>
        <Row label="Fade delay">
          <Chips<number> label="Fade delay" value={chat.fadeSeconds} onChange={(v) => chat2({ fadeSeconds: v })}
            options={[[5, '5 s'], [10, '10 s'], [20, '20 s'], [30, '30 s'], [0, 'Never']]} />
        </Row>
        <Row label="Lettering">
          <Chips<ChatLettering> label="Lettering" value={ui.chatLettering} onChange={(v) => ui2({ chatLettering: v })} options={[['book', 'Book'], ['plain', 'Plain']]} />
        </Row>
        <Row label="Text size">
          <Range value={chat.fontSize} min={14} max={22} onChange={(v) => chat2({ fontSize: v })} format={(v) => `${v} px`} />
        </Row>
        <Row label="Transparency">
          <Range value={chat.chatTransparency} min={0} max={80} step={5} onChange={(v) => chat2({ chatTransparency: v })} format={(v) => `${v}%`} />
        </Row>
        <Row label="Highlight words" hint={'Commas between them; * at the end matches the start of a word.'}>
          <input type="text" className="jset__text" value={chat.customHighlights} maxLength={300} placeholder={'gold, "Aria", trad*'}
            onChange={(e) => chat2({ customHighlights: e.target.value })} onKeyDown={stopKeys} />
        </Row>
      </section>
      <section className="jset__group">
        <h2 className="journal__heading">Names over heads</h2>
        <Row label="Player names">
          <Chips<string> label="Player names" value={chat.hidePlayerNames ? 'hide' : 'show'} onChange={(v) => chat2({ hidePlayerNames: v === 'hide' })} options={[['show', 'Shown'], ['hide', 'Hidden']]} />
        </Row>
        <Row label="Form ids" hint="The number some players use when reporting a problem.">
          <Chips<string> label="Form ids" value={chat.showFormIds ? 'show' : 'hide'} onChange={(v) => chat2({ showFormIds: v === 'show' })} options={[['show', 'Shown'], ['hide', 'Hidden']]} />
        </Row>
      </section>
    </div>
  );
};

// ---- Controls: the game's own keys live in its controlmap, which only the launcher writes --------------------------
const ControlsPart = () => (
  <div className="jset__part">
    <section className="jset__group">
      <h2 className="journal__heading">The game's keys</h2>
      <p className="jset__prose">Activate, Jump, Sprint, Sneak, Shout, Toggle POV and Invert Y are kept in the game&apos;s own control map, which the game reads once as it starts.</p>
      <p className="jset__prose">Change these in the launcher (Settings), then restart the game.</p>
    </section>
  </div>
);

// ---- Help ---------------------------------------------------------------------------------------------------------
const HelpPart = ({ act, busy }: SettingsPartProps) => {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => { if (!busy && sent) { setText(''); setSent(false); } }, [busy]);
  return (
    <div className="jset__part">
      <section className="jset__group">
        <h2 className="journal__heading">Report a problem</h2>
        <p className="jset__prose">Say what you were doing and what went wrong. Where you stand and what is around you are sent with it, as with /bug.</p>
        <textarea className="jset__area" rows={4} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={stopKeys}
          placeholder="the wolf near me is floating" />
        <div className="jset__actions">
          <span className="journal__hint">{text.length} / 500</span>
          <button type="button" className="journal__button journal__button--primary" disabled={busy || text.trim().length < 5}
            onClick={() => { setSent(true); act('journalReport', text); }}>Send the report</button>
        </div>
      </section>
      <section className="jset__group">
        <h2 className="journal__heading">Repairs</h2>
        <p className="jset__prose">Repairing the game files, opening the log folder and resetting every setting are done from the launcher, with the game closed.</p>
      </section>
    </div>
  );
};

registerSettingsSection('controls', 'Controls', ControlsPart);
registerSettingsSection('interface', 'Interface', InterfacePart);
registerSettingsSection('help', 'Help', HelpPart);

export const SettingsTab = ({ section, busy, act }: JournalTabProps<SettingsSection>) => {
  const s = (section || {}) as SettingsSection;
  const parts = PARTS.filter((p) => !p.shown || p.shown(s));
  const want = s.focusPeer && parts.some((p) => p.id === 'voice') ? 'voice' : s.section;
  const [open, setOpen] = useState<string>(() => (want && parts.some((p) => p.id === want) ? want : (parts[0] || { id: '' }).id));
  // A deep link (X's "Voice settings for <name>") opens its section
  useEffect(() => { if (want && parts.some((p) => p.id === want)) setOpen(want); }, [want, s.focusPeer]);
  const part = parts.find((p) => p.id === open) || parts[0];
  const Body = part ? part.component : null;
  return (
    <div className="jset">
      <nav className="jset__rail" aria-label="Settings">
        {parts.map((p) => (
          <button key={p.id} type="button" className={'jset__rail-item' + (part && p.id === part.id ? ' jset__rail-item--on' : '')} onClick={() => setOpen(p.id)}>{p.label}</button>
        ))}
      </nav>
      <div className="jset__content">{Body ? <Body section={s} act={act} busy={busy} /> : null}</div>
    </div>
  );
};

registerJournalTab('settings', SettingsTab, 'aqua');
