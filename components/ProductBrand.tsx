import type { CSSProperties } from "react";

interface ProductBrandProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  mutedPi?: boolean;
}

/** Product wordmark: TianForge is the product, while pi is the smaller foundation mark. */
export function ProductBrand({ size = 22, className, style, mutedPi = true }: ProductBrandProps) {
  return (
    <span
      className={className}
      aria-label="TianForge pi"
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: "0.32em",
        color: "var(--text)",
        fontSize: size,
        fontWeight: 700,
        letterSpacing: "-0.025em",
        lineHeight: 1,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      <span aria-hidden="true">TianForge</span>
      <span
        aria-hidden="true"
        style={{
          color: mutedPi ? "var(--text-muted)" : "currentColor",
          fontSize: "0.56em",
          fontWeight: 650,
          letterSpacing: "0.02em",
        }}
      >
        pi
      </span>
    </span>
  );
}
