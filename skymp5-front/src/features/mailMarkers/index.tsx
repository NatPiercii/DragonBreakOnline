import React from 'react';

import './styles.scss';

// Letter icons over nearby notice boards while unread pigeons wait (client BoardMailService, widget "mailMarkers")
export interface MailMarker {
  x: number;
  y: number;
  near: number;
}

export interface MailMarkersData {
  id: number;
  markers: MailMarker[];
  unread: number;
}

const Envelope = () => (
  <svg className="mailMarkers__icon" viewBox="0 0 48 36" aria-hidden="true">
    <rect x="2" y="2" width="44" height="32" rx="3" className="mailMarkers__paper" />
    <path d="M3 4 L24 21 L45 4" className="mailMarkers__fold" />
    <circle cx="24" cy="21" r="6" className="mailMarkers__seal" />
  </svg>
);

const MailMarkers = ({ data }: { data: MailMarkersData }) => (
  <div className="mailMarkers">
    {(data.markers || []).map((m, i) => (
      <div
        key={i}
        className="mailMarkers__marker"
        style={{ left: (m.x * 100) + '%', top: (m.y * 100) + '%', transform: 'translate(-50%, -100%) scale(' + (0.6 + 0.6 * Math.max(0, Math.min(1, m.near))) + ')' }}
      >
        <div className="mailMarkers__bob">
          <Envelope />
          {data.unread > 1 && <span className="mailMarkers__count">{data.unread}</span>}
        </div>
      </div>
    ))}
  </div>
);

export default MailMarkers;
