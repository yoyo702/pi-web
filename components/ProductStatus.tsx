"use client";

import type { CSSProperties } from "react";
import { PRODUCT_STATUS_GROUP_LABELS, PRODUCT_STATUS_GUIDE, getProductStatus, type ProductStatusGroup, type ProductStatusId } from "@/lib/product-status";

export function ProductStatusDot({ status, size = 7, halo = false, title, style }: { status: ProductStatusId; size?: number; halo?: boolean; title?: string; style?: CSSProperties }) {
  const definition = getProductStatus(status);
  const accessibleLabel = title ?? definition.label;
  return <span title={accessibleLabel} aria-label={accessibleLabel} style={{ width: size, height: size, flex: `0 0 ${size}px`, display: "inline-block", borderRadius: "50%", background: definition.color, boxShadow: halo ? `0 0 0 3px color-mix(in srgb,${definition.color} 16%,transparent)` : undefined, ...style }} />;
}

export function ProductStatusGuide() {
  const groups = PRODUCT_STATUS_GUIDE.reduce((result, id) => {
    const definition = getProductStatus(id);
    (result[definition.group] ??= []).push(definition);
    return result;
  }, {} as Record<ProductStatusGroup, ReturnType<typeof getProductStatus>[]>);

  return <div className="settings-status-guide">{Object.entries(groups).map(([group, definitions]) => <section key={group} className="settings-status-group"><h3>{PRODUCT_STATUS_GROUP_LABELS[group as ProductStatusGroup]}</h3>{definitions.map((definition) => <div key={definition.id} className="settings-status-row"><ProductStatusDot status={definition.id} size={9} halo /><span><strong>{definition.label}</strong><small>{definition.description}</small></span></div>)}</section>)}</div>;
}
