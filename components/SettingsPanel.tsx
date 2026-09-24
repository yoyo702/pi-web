"use client";

import { useEffect, useState } from "react";
import { Box, CircleHelp, Moon, Puzzle, Settings, Sparkles, Sun, Volume2, VolumeX, Wifi, X } from "lucide-react";
import { useAudio } from "@/hooks/useAudio";
import { MobileAccessDialog } from "./MobileAccessDialog";
import { ModelsConfig } from "./ModelsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { ProductStatusGuide } from "./ProductStatus";
import { SkillsConfig } from "./SkillsConfig";

type SettingsSection = "general" | "access" | "models" | "skills" | "plugins" | "status";

interface Props {
  isDark: boolean;
  cwd: string | null;
  sessionId: string | null;
  onClose: () => void;
  onToggleTheme: () => void;
  onModelsChanged?: () => void;
  onPluginsReloaded?: () => void;
}

const sections: Array<{ id: SettingsSection; label: string; projectRequired?: boolean; icon: typeof Settings }> = [
  { id: "general", label: "Appearance", icon: Settings },
  { id: "access", label: "Remote access", icon: Wifi },
  { id: "models", label: "Models", icon: Box },
  { id: "skills", label: "Skills", projectRequired: true, icon: Sparkles },
  { id: "plugins", label: "Plugins", projectRequired: true, icon: Puzzle },
  { id: "status", label: "Status & indicators", icon: CircleHelp },
];

export function SettingsPanel({ isDark, cwd, sessionId, onClose, onToggleTheme, onModelsChanged, onPluginsReloaded }: Props) {
  const [section, setSection] = useState<SettingsSection>("general");
  const { soundEnabled, onSoundToggle } = useAudio();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const closeChild = () => setSection("general");
  const embedded = section === "access" || section === "models" || section === "skills" || section === "plugins";

  return <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-panel">
      <header className="settings-header"><Settings size={16} /><strong>Settings</strong><button type="button" aria-label="Close settings" onClick={onClose}><X size={15} /></button></header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(({ id, label, projectRequired, icon: Icon }) => <button key={id} type="button" className={section === id ? "is-active" : ""} disabled={projectRequired && !cwd} title={projectRequired && !cwd ? `Open a project to configure ${label.toLowerCase()}` : label} onClick={() => setSection(id)}><Icon size={14} /><span>{label}</span></button>)}
        </nav>
        <main className={`settings-content${embedded ? " is-embedded" : ""}`}>
          {section === "general" && <>
            <div className="settings-title"><h2>Appearance</h2><p>Changes apply immediately across TianForge.</p></div>
            <section className="settings-section"><h3>Theme</h3><button type="button" className="settings-action-row" onClick={onToggleTheme}>{isDark ? <Moon size={16} /> : <Sun size={16} />}<span><strong>Color theme</strong><small>{isDark ? "Dark" : "Light"}</small></span><span className="settings-value">Switch to {isDark ? "light" : "dark"}</span></button></section>
            <section className="settings-section"><h3>Notifications</h3><button type="button" className="settings-action-row" onClick={onSoundToggle}>{soundEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}<span><strong>Completion sound</strong><small>Play a tone when an agent finishes</small></span><span className="settings-value">{soundEnabled ? "On" : "Off"}</span></button></section>
          </>}
          {section === "access" && <MobileAccessDialog embedded onClose={closeChild} />}
          {section === "models" && <ModelsConfig embedded onClose={() => { onModelsChanged?.(); closeChild(); }} />}
          {section === "skills" && cwd && <SkillsConfig embedded cwd={cwd} onClose={closeChild} />}
          {section === "plugins" && cwd && <PluginsConfig embedded cwd={cwd} sessionId={sessionId} onClose={closeChild} onReloaded={onPluginsReloaded} />}
          {section === "status" && <>
            <div className="settings-title"><h2>Status & indicators</h2><p>One shared vocabulary is used across projects, tabs, files, sessions, agents, and connections.</p></div>
            <ProductStatusGuide />
            <p className="settings-hint">Color is supplemental: indicators also expose a label or tooltip. A project can show source-control and runtime states at the same time.</p>
          </>}
        </main>
      </div>
    </section>
  </div>;
}
