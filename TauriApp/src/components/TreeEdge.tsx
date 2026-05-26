import { BaseEdge, type EdgeProps } from "@xyflow/react";

/**
 * A clean outline/tree connector: straight down from the parent's bottom-left,
 * one rounded corner, then straight right into the child's left side. Avoids
 * the S-curve "kink" smoothstep produces between a bottom source and a left
 * target handle.
 */
export default function TreeEdge({ sourceX, sourceY, targetX, targetY, markerEnd, style }: EdgeProps) {
  const dir = targetX >= sourceX ? 1 : -1;
  const r = Math.max(0, Math.min(7, Math.abs(targetX - sourceX), Math.abs(targetY - sourceY)));
  const path =
    `M ${sourceX},${sourceY} ` +
    `L ${sourceX},${targetY - r} ` +
    `Q ${sourceX},${targetY} ${sourceX + dir * r},${targetY} ` +
    `L ${targetX},${targetY}`;
  return <BaseEdge path={path} style={style} markerEnd={markerEnd} />;
}
