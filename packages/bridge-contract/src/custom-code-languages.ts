export interface CustomCodeLanguageManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  aliases: string[];
  scopeName: string;
  enabled: boolean;
}

/** Renderer-ready language record returned by the host bridge. */
export interface CustomCodeLanguage extends CustomCodeLanguageManifest {
  grammar: string;
  error?: string;
}

export interface CustomCodeLanguageInstallInput {
  fileName: string;
  grammar: string;
  id: string;
  name: string;
  aliases: string[];
  enabled?: boolean;
  replace?: boolean;
}

export interface CustomCodeLanguageUpdateInput {
  id: string;
  name?: string;
  aliases?: string[];
  enabled?: boolean;
}
