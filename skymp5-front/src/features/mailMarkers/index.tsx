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

// A gold-rimmed medallion holding a sealed letter and a pigeon's feather: pigeon post, in the Heart and Hourglass palette
const MailIcon = () => (
  <svg className="mailMarkers__icon" viewBox="0 0 64 64" aria-hidden="true">
    <defs>
      <radialGradient id="mailMarkersDisc" cx="50%" cy="40%" r="60%">
        <stop offset="0%" stopColor="#173236" />
        <stop offset="100%" stopColor="#08191c" />
      </radialGradient>
      <linearGradient id="mailMarkersPaper" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor="#f6ebc8" />
        <stop offset="100%" stopColor="#dcc692" />
      </linearGradient>
    </defs>
    <circle cx="32" cy="32" r="29" className="mailMarkers__disc" fill="url(#mailMarkersDisc)" />
    <circle cx="32" cy="32" r="25.5" className="mailMarkers__inner" />
    <path d="M20 14 C12 16 9 25 14 31 C16 26 19 21 23 18 Z" className="mailMarkers__feather" />
    <path d="M23 18 L15 29" className="mailMarkers__quill" />
    <rect x="20" y="23" width="30" height="21" rx="2" className="mailMarkers__paper" fill="url(#mailMarkersPaper)" />
    <path d="M21 24.5 L35 35 L49 24.5" className="mailMarkers__fold" />
    <path d="M21 43 L31 34 M49 43 L39 34" className="mailMarkers__fold mailMarkers__fold--back" />
    <circle cx="35" cy="35" r="5" className="mailMarkers__seal" />
    <path d="M32.7 35 L35 32.7 L37.3 35 L35 37.3 Z" className="mailMarkers__sealMark" />
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
          <span className="mailMarkers__pulse" />
          <MailIcon />
          {data.unread > 1 && <span className="mailMarkers__count">{data.unread}</span>}
        </div>
      </div>
    ))}
  </div>
);

export default MailMarkers;
