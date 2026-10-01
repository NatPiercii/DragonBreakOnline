// Plants and trees are harvested by the server: the engine's own harvest stays off, and the server's answer is not replayed
// as a local activation (that added the produce on top of the inventory the server had already sent)

// FormType.Flora and FormType.Tree; a const enum cannot be read outside SkyrimPlatform
export const FLORA_FORM_TYPE = 39;
export const TREE_FORM_TYPE = 38;

export const isServerHarvested = (formType: number | null | undefined): boolean =>
  formType === FLORA_FORM_TYPE || formType === TREE_FORM_TYPE;

// The HUD line the engine's harvest would have shown; nothing for produce without a name (a leveled list)
export const harvestNotice = (produceName: string | null | undefined): string | null => {
  const name = String(produceName || "").trim();
  return name ? `${name} added` : null;
};
