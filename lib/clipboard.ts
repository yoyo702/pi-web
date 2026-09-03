function legacyCopyText(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    ta.style.opacity = "0";
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(ta);
    return copied;
  } catch {
    return false;
  }
}

export async function copyText(text: string): Promise<void> {
  // Clipboard API is unavailable on ordinary LAN HTTP origins and can also be
  // present but reject because of browser permissions. Always retain the
  // synchronous execCommand fallback instead of treating API presence as
  // proof that copying will succeed.
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path.
    }
  }
  if (!legacyCopyText(text)) throw new Error("Clipboard write failed");
}
