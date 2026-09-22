import { Theme } from "@earendil-works/pi-coding-agent";

type ThemeForegrounds = ConstructorParameters<typeof Theme>[0];
type ThemeBackgrounds = ConstructorParameters<typeof Theme>[1];

// Keep this exhaustive instead of casting a partial object. Pi derives new
// optional colors from required tokens inside Theme's constructor, so a
// missing token can crash route-module initialization before our no-op method
// overrides are ever used.
const EMPTY_FOREGROUNDS: ThemeForegrounds = {
  accent: "",
  border: "",
  borderAccent: "",
  borderMuted: "",
  success: "",
  error: "",
  warning: "",
  muted: "",
  dim: "",
  text: "",
  thinkingText: "",
  scrollbarTrack: "",
  scrollbarThumb: "",
  searchMatchText: "",
  userMessageText: "",
  customMessageText: "",
  customMessageLabel: "",
  toolTitle: "",
  toolOutput: "",
  mdHeading: "",
  mdLink: "",
  mdLinkUrl: "",
  mdCode: "",
  mdCodeBlock: "",
  mdCodeBlockBorder: "",
  mdQuote: "",
  mdQuoteBorder: "",
  mdHr: "",
  mdListBullet: "",
  toolDiffAdded: "",
  toolDiffRemoved: "",
  toolDiffContext: "",
  syntaxComment: "",
  syntaxKeyword: "",
  syntaxFunction: "",
  syntaxVariable: "",
  syntaxString: "",
  syntaxNumber: "",
  syntaxType: "",
  syntaxOperator: "",
  syntaxPunctuation: "",
  thinkingOff: "",
  thinkingMinimal: "",
  thinkingLow: "",
  thinkingMedium: "",
  thinkingHigh: "",
  thinkingXhigh: "",
  thinkingMax: "",
  bashMode: "",
};

const EMPTY_BACKGROUNDS: ThemeBackgrounds = {
  selectedBg: "",
  searchMatchBg: "",
  userMessageBg: "",
  customMessageBg: "",
  toolPendingBg: "",
  toolSuccessBg: "",
  toolErrorBg: "",
};

// Extensions require a real Theme instance, while the web UI applies all
// visual styling itself. Preserve the instance contract but strip ANSI output.
export class PlainTextTheme extends Theme {
  constructor() {
    super(EMPTY_FOREGROUNDS, EMPTY_BACKGROUNDS, "truecolor");
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string { return (text) => text; }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

export function createPlainTextTheme(): Theme {
  return new PlainTextTheme();
}
