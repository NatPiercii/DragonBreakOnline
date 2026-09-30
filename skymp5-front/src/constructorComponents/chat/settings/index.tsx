import React, { useRef, useState, useLayoutEffect } from 'react';
import { SkyrimFrame } from '../../../components/SkyrimFrame/SkyrimFrame';
import { SkyrimSlider } from '../../../components/SkyrimSlider/SkyrimSlider';
import CheckBox from '../../checkbox/index';
import './styles.scss';

const Settings = (props: {
  fontSize: number,
  setFontSize: (size: number) => void,
  lockChat: boolean,
  setLockChat: (value: boolean) => void,
  hidePlayerNames: boolean,
  setHidePlayerNames: (value: boolean) => void,
  showFormIds: boolean,
  setShowFormIds: (value: boolean) => void,
  chatTransparency: number,
  setChatTransparency: (value: number) => void,
  fadeSeconds: number,
  setFadeSeconds: (value: number) => void,
  customHighlights: string,
  setCustomHighlights: (value: string) => void,
  chatBubbles: boolean,
  setChatBubbles: (value: boolean) => void,
  bubbleSize: number,
  setBubbleSize: (value: number) => void,
  onBack: () => void,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [frameHeight, setFrameHeight] = useState(520);
  // Auto-size the frame to its content so everything fits without a scrollbar.
  useLayoutEffect(() => {
    if (contentRef.current) setFrameHeight(Math.ceil(contentRef.current.scrollHeight) + 64);
  }, []);
  return (
    <div className='chat-settings' style={{ height: `${frameHeight}px` }}>
      <button
        type='button'
        className='chat-settings-back'
        title='Back'
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => props.onBack()}
      >
        {'Back'}
      </button>
      <div className='content' ref={contentRef}>
        <SkyrimSlider text={'font size'} name={'fontSize'} min={14} max={22} setValue={(value) => props.setFontSize(value)} sliderValue={props.fontSize} marks={[14, 15, 16, 17, 18, 19, 20, 21, 22]}/>
        <SkyrimSlider text={'transparency'} name={'transparency'} min={0} max={80} setValue={(value) => props.setChatTransparency(value)} sliderValue={props.chatTransparency} marks={[0, 20, 40, 60, 80]}/>
        <SkyrimSlider text={'fade (seconds, 0 = never)'} name={'fadeSeconds'} min={0} max={60} setValue={(value) => props.setFadeSeconds(value)} sliderValue={props.fadeSeconds} marks={[0, 10, 20, 30, 45, 60]}/>
        <CheckBox text={'lock chat'} initialValue={props.lockChat} setChecked={props.setLockChat} disabled={false} />
        <CheckBox text={'hide player names'} initialValue={props.hidePlayerNames} setChecked={props.setHidePlayerNames} disabled={false} />
        <CheckBox text={'show form ids'} initialValue={props.showFormIds} setChecked={props.setShowFormIds} disabled={false} />
        <CheckBox text={'chat bubbles over heads'} initialValue={props.chatBubbles} setChecked={props.setChatBubbles} disabled={false} />
        <SkyrimSlider text={'bubble size'} name={'bubbleSize'} min={30} max={100} setValue={(value) => props.setBubbleSize(value)} sliderValue={props.bubbleSize} marks={[30, 40, 55, 70, 85, 100]}/>
        <div className='chat-highlights'>
          <span className='chat-highlights-label'>highlight words</span>
          <textarea
            className='chat-highlights-input'
            value={props.customHighlights}
            placeholder={'gold, "Aria", trad*'}
            onChange={(e) => props.setCustomHighlights(e.target.value)}
          />
        </div>
      </div>
      <SkyrimFrame width={512} height={frameHeight} header={false} name={'Settings'}/>
    </div>
  );
};

export default Settings;
