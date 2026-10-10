// Every hub tab beyond the four index.tsx draws: one import per tab module, each of which calls registerJournalTab
// (tabs.ts). Add a line here for a new tab; nothing else in the journal needs to change.
import './tabs/DeityTab';
import './tabs/ThalmorTab';
import './tabs/MagicTab';
import './tabs/SettingsTab';
import './tabs/SettingsKeys';
import './tabs/SettingsVoice';
import './skillsTab';
import '../court';
import '../nobility';
