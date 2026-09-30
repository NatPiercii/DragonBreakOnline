// What keeps a character's name off screen; the nametag and the chat bubbles both read it from FormView.identityFacts
export interface IdentityFacts {
  beast: boolean;
  adminHidden: boolean;
  sweetHidden: boolean;
}

export const hidesIdentity = (f: IdentityFacts): boolean => f.beast || f.adminHidden || f.sweetHidden;
