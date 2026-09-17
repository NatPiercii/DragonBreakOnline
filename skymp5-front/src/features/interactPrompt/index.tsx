import React from 'react';

import './styles.scss';

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface InteractPromptData {
  verb: string;
  label: string;
}

const InteractPrompt = ({ data }: { data: InteractPromptData }) => {
  if (!data.label) return null;
  // Load doors carry no verb: the destination name alone
  return (
    <div className="interactPrompt">
      {data.verb ? <span className="interactPrompt__verb">{data.verb}</span> : null}
      <span className="interactPrompt__label">{data.label}</span>
    </div>
  );
};

export default InteractPrompt;
