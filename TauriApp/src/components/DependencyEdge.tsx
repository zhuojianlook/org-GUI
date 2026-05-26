import { getBezierPath, useInternalNode, EdgeLabelRenderer, Position, type EdgeProps, type InternalNode } from "@xyflow/react";
import { useOrgStore } from "../store/useOrgStore";

// Floating-edge geometry: connect the two nodes at the points on their borders
// that face each other, so a dependency arrow takes the shortest sensible path
// rather than always leaving/entering a fixed side. Adapted from React Flow's
// floating-edges example.

function nodeCenter(n: InternalNode) {
  return {
    x: n.internals.positionAbsolute.x + (n.measured.width ?? 0) / 2,
    y: n.internals.positionAbsolute.y + (n.measured.height ?? 0) / 2,
  };
}

/** Intersection of the line (center→other center) with NODE's rectangle border. */
function getNodeIntersection(node: InternalNode, other: InternalNode) {
  const w = (node.measured.width ?? 0) / 2;
  const h = (node.measured.height ?? 0) / 2;
  const x2 = node.internals.positionAbsolute.x + w;
  const y2 = node.internals.positionAbsolute.y + h;
  const { x: x1, y: y1 } = nodeCenter(other);

  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = a * xx1;
  const yy3 = a * yy1;
  return { x: w * (xx3 + yy3) + x2, y: h * (-xx3 + yy3) + y2 };
}

/** Which side of NODE the intersection point sits on (for the bezier tangent). */
function getEdgePosition(node: InternalNode, p: { x: number; y: number }): Position {
  const nx = Math.round(node.internals.positionAbsolute.x);
  const ny = Math.round(node.internals.positionAbsolute.y);
  const px = Math.round(p.x);
  const py = Math.round(p.y);
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  if (px <= nx + 1) return Position.Left;
  if (px >= nx + w - 1) return Position.Right;
  if (py <= ny + 1) return Position.Top;
  if (py >= ny + h - 1) return Position.Bottom;
  return Position.Top;
}

export default function DependencyEdge({ id, source, target, markerEnd, style, data }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const depMode = useOrgStore((s) => s.depMode);
  const removeDependency = useOrgStore((s) => s.removeDependency);
  const nodes = useOrgStore((s) => s.doc?.nodes);
  // Wait until both nodes are measured (floating geometry needs their sizes).
  if (!sourceNode?.measured?.width || !targetNode?.measured?.width) return null;

  const sp = getNodeIntersection(sourceNode, targetNode);
  const tp = getNodeIntersection(targetNode, sourceNode);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sp.x,
    sourceY: sp.y,
    sourcePosition: getEdgePosition(sourceNode, sp),
    targetX: tp.x,
    targetY: tp.y,
    targetPosition: getEdgePosition(targetNode, tp),
  });

  const onRemove = () => {
    const d = data as { from: string; to: string } | undefined;
    if (!d || !nodes) return;
    const from = nodes.find((n) => n.id === d.from);
    const to = nodes.find((n) => n.id === d.to);
    if (from && to) removeDependency(from, to);
  };

  return (
    <>
      <path id={id} className="react-flow__edge-path" d={path} markerEnd={markerEnd} style={style} />
      {/* In dep mode, a small ✕ on the link's midpoint removes it (more robust
          than clicking the thin line). */}
      {depMode && (
        <EdgeLabelRenderer>
          <button
            className="nodrag nopan"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            title="Remove this dependency link"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
              width: 18,
              height: 18,
              borderRadius: 9,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#1c1c1e",
              color: "#ff6c6b",
              border: "1.5px solid #ff6c6b",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 700,
              lineHeight: 1,
              padding: 0,
              boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
            }}
          >
            ✕
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
