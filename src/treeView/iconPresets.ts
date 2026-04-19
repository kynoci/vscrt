/**
 * Shared icon catalogue used by the "Change Icon" QuickPick and the
 * Add/Edit Server form dropdown. Keeping these in one place ensures both
 * surfaces offer the same choices.
 *
 * `kind: 'custom'` entries resolve to SVG files under `media/icons/`
 * (see `CUSTOM_ICON_FILES`). Everything else is a bundled codicon name.
 */

export type IconPresetKind = "custom" | "codicon";

export interface IconPreset {
  id: string;
  label: string;
  kind: IconPresetKind;
}

export const CUSTOM_ICON_FILES: Record<string, string> = {
  mac: "apple.svg",
  finder: "finder.svg",
  freebsd: "freebsd.svg",
  briefcase: "briefcase.svg",
  computer: "computer.svg",
  "computer-aio": "computer-aio.svg",
  laptop: "laptop.svg",
  "load-balancer": "load-balancer.svg",
  "network-switch": "network-switch.svg",
  wifi: "wifi.svg",
  win: "windows.svg",
};

const CUSTOM_ICON_PRESETS: IconPreset[] = [
  { id: "mac", label: "macOS (Apple logo)", kind: "custom" },
  { id: "finder", label: "macOS Finder", kind: "custom" },
  { id: "win", label: "Windows (logo)", kind: "custom" },
  { id: "freebsd", label: "FreeBSD (Beastie)", kind: "custom" },
  { id: "briefcase", label: "Briefcase", kind: "custom" },
  { id: "computer", label: "Computer (desktop + monitor)", kind: "custom" },
  { id: "computer-aio", label: "Computer (all-in-one)", kind: "custom" },
  { id: "laptop", label: "Laptop", kind: "custom" },
  { id: "load-balancer", label: "Load balancer", kind: "custom" },
  { id: "network-switch", label: "Network switch", kind: "custom" },
  { id: "wifi", label: "Wi-Fi", kind: "custom" },
];

const TERMINAL_ICON_PRESETS: IconPreset[] = [
  { id: "terminal-powershell", label: "Windows — PowerShell", kind: "codicon" },
  { id: "terminal-bash", label: "macOS — bash", kind: "codicon" },
  { id: "terminal-linux", label: "Linux — Tux", kind: "codicon" },
  { id: "terminal", label: "Unix — generic terminal", kind: "codicon" },
];

/** Kept for backwards compatibility with the iconCommand QuickPick. */
export const OS_ICON_PRESETS: IconPreset[] = [
  ...CUSTOM_ICON_PRESETS,
  ...TERMINAL_ICON_PRESETS,
];

export const GENERIC_ICON_PRESETS: IconPreset[] = [
  "folder",
  "folder-library",
  "folder-opened",
  "organization",
  "server",
  "server-environment",
  "server-process",
  "vm",
  "vm-active",
  "cloud",
  "database",
  "rocket",
  "globe",
  "shield",
  "lock",
  "key",
  "terminal-ubuntu",
  "chip",
  "circuit-board",
  "package",
  "account",
  "star",
  "heart",
  "flame",
  "tools",
].map((id) => ({ id, label: id, kind: "codicon" as const }));

export interface IconPresetGroup {
  title: string;
  items: IconPreset[];
}

/** Groups shown in the form dropdown, in display order. */
export const ICON_PRESET_GROUPS: IconPresetGroup[] = [
  { title: "Custom", items: CUSTOM_ICON_PRESETS },
  { title: "OS terminals", items: TERMINAL_ICON_PRESETS },
  { title: "Generic", items: GENERIC_ICON_PRESETS },
];

export const ALL_ICON_PRESETS: IconPreset[] = ICON_PRESET_GROUPS.flatMap(
  (g) => g.items,
);

export function isCustomIcon(id: string | undefined): boolean {
  return !!id && Object.prototype.hasOwnProperty.call(CUSTOM_ICON_FILES, id);
}
