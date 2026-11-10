export type LinkedSlate = string | false | null;

declare module 'claude-code' {
  interface PluginState {
    slate: {
      linked: LinkedSlate;
      names: string[];
      query: string;
      prompts: string[];
      asked: boolean;
      suggestion: string | null;
    };
  }
}
