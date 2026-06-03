import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import { useOrgStore } from "../store/useOrgStore";
import { wouldCreateCycle } from "../api/org";
import { buildLayout, INDENT_X, type OrgNodeView } from "../utils/layout";
import OrgNode, { levelColor } from "./OrgNode";
import TreeEdge from "./TreeEdge";
import DependencyEdge from "./DependencyEdge";
import SelectionBar from "./SelectionBar";
import TagAura from "./TagAura";

const nodeTypes = { org: OrgNode };
const edgeTypes = { tree: TreeEdge, dependency: DependencyEdge };

type DragState =
  | { kind: "root"; id: string; sx: number; sy: number; desc: { id: string; sx: number; sy: number }[] }
  | {
      kind: "child";
      id: string;
      startX: number;
      sibs: { id: string; y: number }[];
      origIndex: number;
      parentId: string | null;
      parentLevel: number;
      descSet: Set<string>;
    };

export default function TimelineGraph() {
  const doc = useOrgStore((s) => s.doc);
  const select = useOrgStore((s) => s.select);
  const flashNode = useOrgStore((s) => s.flashNode);
  const expanded = useOrgStore((s) => s.expanded);
  const tableCollapsed = useOrgStore((s) => s.tableCollapsed);
  const tagFilter = useOrgStore((s) => s.tagFilter);
  const rootPositions = useOrgStore((s) => s.rootPositions);
  const setRootPosition = useOrgStore((s) => s.setRootPosition);
  const setDropTarget = useOrgStore((s) => s.setDropTarget);
  const reorder = useOrgStore((s) => s.reorder);
  const refile = useOrgStore((s) => s.refile);
  const depMode = useOrgStore((s) => s.depMode);
  const scheduleMode = useOrgStore((s) => s.scheduleMode);
  const setScheduleDragNode = useOrgStore((s) => s.setScheduleDragNode);
  const addDependency = useOrgStore((s) => s.addDependency);
  const setConnectDrag = useOrgStore((s) => s.setConnectDrag);
  const rf = useReactFlow();

  const layout = useMemo(
    () => (doc ? buildLayout(doc, expanded, rootPositions, tableCollapsed) : null),
    [doc, expanded, rootPositions, tableCollapsed],
  );

  const byId = useMemo(() => new Map((doc?.nodes ?? []).map((n) => [n.id, n] as const)), [doc]);
  const childMap = useMemo(() => {
    const m = new Map<string, string[]>();
    doc?.nodes.forEach((n) => {
      if (n.parent) (m.get(n.parent) ?? m.set(n.parent, []).get(n.parent)!).push(n.id);
    });
    return m;
  }, [doc]);
  const rootIndexById = useMemo(() => {
    const m = new Map<string, number>();
    let i = 0;
    doc?.nodes.forEach((n) => {
      if (!n.parent) m.set(n.id, i++);
    });
    return m;
  }, [doc]);

  // Dependency arrows (prerequisite → dependent), resolved from each node's
  // DEPENDS_ON org IDs to currently-visible node ids. Always shown; only
  // editable in dep mode.
  const depEdges = useMemo<Edge[]>(() => {
    if (!doc || !layout) return [];
    const visible = new Set(layout.nodes.map((n) => n.id));
    const byOrgId = new Map<string, string>();
    const nodeById = new Map<string, typeof doc.nodes[number]>();
    for (const n of doc.nodes) {
      if (n.orgId) byOrgId.set(n.orgId, n.id);
      nodeById.set(n.id, n);
    }
    const out: Edge[] = [];
    for (const n of doc.nodes) {
      for (const pid of n.dependsOn ?? []) {
        const src = byOrgId.get(pid);
        if (!src || !visible.has(src) || !visible.has(n.id)) continue;
        // When the tag filter is on, an edge is "relevant" only when BOTH
        // endpoints carry the active tag. Irrelevant edges fade in sync with
        // the irrelevant nodes so the tagged subgraph stands out clearly.
        const srcNode = nodeById.get(src);
        const tgtNode = n;
        const filtered =
          tagFilter != null &&
          (!(srcNode?.tagsAll ?? []).includes(tagFilter) ||
            !(tgtNode.tagsAll ?? []).includes(tagFilter));
        out.push({
          id: `dep-${src}-${n.id}`,
          source: src,
          target: n.id,
          type: "dependency",
          data: { from: src, to: n.id },
          zIndex: 2000, // render dependency links ABOVE nodes (node zIndex is 10)
          markerEnd: { type: MarkerType.ArrowClosed, color: "#e0a458", width: 16, height: 16 },
          style: {
            stroke: "#e0a458",
            strokeWidth: 1.8,
            strokeDasharray: "5 4",
            opacity: filtered ? 0.18 : 1,
          },
        });
      }
    }
    return out;
  }, [doc, layout, tagFilter]);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const dragRef = useRef<DragState | null>(null);

  useEffect(() => {
    if (layout) setNodes(layout.nodes);
  }, [layout, setNodes]);

  useEffect(() => {
    if (layout) setEdges([...layout.edges, ...depEdges]);
  }, [layout, depEdges, setEdges]);

  // Manual drag-to-connect for dependency mode. We use NATIVE capture-phase
  // listeners on the wrapper (not React's synthetic onPointerDownCapture) so the
  // gesture fires before React Flow and works reliably. React Flow's built-in
  // connection only registers within ~20px of a handle's single center point,
  // which makes "drop onto a wide node" unreliable — so we wire it ourselves:
  // press on any node, drag, release over another node.
  const wrapRef = useRef<HTMLDivElement>(null);
  const connectFromRef = useRef<string | null>(null);
  const [tmpLine, setTmpLine] = useState<{ x1: number; y1: number; x2: number; y2: number; valid: boolean } | null>(null);

  // A link is allowed unless it's a self-link, joins two nodes that share the
  // same parent (siblings — "comparable tier" nodes shouldn't depend on each
  // other), or would create a dependency cycle (A→B→C→A).
  const canLink = useCallback(
    (fromId: string, toId: string): boolean => {
      if (!fromId || !toId || fromId === toId) return false;
      const a = byId.get(fromId);
      const b = byId.get(toId);
      if (!a || !b) return false;
      if (a.parent && a.parent === b.parent) return false;
      if (wouldCreateCycle(a, b, doc)) return false;
      return true;
    },
    [byId, doc],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Which node's box contains the point? Uses rect containment rather than
    // document.elementFromPoint so it's robust to overlays (the temp line) and
    // independent of hit-testing quirks.
    const nodeIdAt = (x: number, y: number): string | null => {
      for (const el of document.querySelectorAll<HTMLElement>(".react-flow__node")) {
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el.getAttribute("data-id");
      }
      return null;
    };

    const onDown = (e: PointerEvent) => {
      if (!depMode || e.button !== 0) return;
      const nodeEl = (e.target as HTMLElement).closest(".react-flow__node") as HTMLElement | null;
      const fromId = nodeEl?.getAttribute("data-id");
      if (!nodeEl || !fromId) return; // empty pane → let React Flow pan
      e.preventDefault();
      e.stopPropagation();
      connectFromRef.current = fromId;
      const r = nodeEl.getBoundingClientRect();
      setTmpLine({ x1: r.left + r.width / 2, y1: r.top + r.height / 2, x2: e.clientX, y2: e.clientY, valid: false });
      setConnectDrag(fromId, null, false);
      const move = (ev: PointerEvent) => {
        const from = connectFromRef.current;
        if (!from) return;
        const overId = nodeIdAt(ev.clientX, ev.clientY);
        const hoverId = overId && overId !== from ? overId : null;
        const valid = !!hoverId && canLink(from, hoverId);
        setConnectDrag(from, hoverId, valid);
        setTmpLine((l) => (l ? { ...l, x2: ev.clientX, y2: ev.clientY, valid } : l));
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setTmpLine(null);
        setConnectDrag(null, null, false);
        const from = connectFromRef.current;
        connectFromRef.current = null;
        if (!from) return;
        const toId = nodeIdAt(ev.clientX, ev.clientY);
        if (toId && canLink(from, toId)) {
          const a = byId.get(from);
          const b = byId.get(toId);
          if (a && b) addDependency(a, b);
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

    // In dep mode, swallow node clicks (select/edit/checkbox) so the drag gesture
    // owns the node surface. Edge clicks (removal) and pane clicks pass through.
    const onClickCap = (e: MouseEvent) => {
      if (depMode && (e.target as HTMLElement).closest(".react-flow__node")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("click", onClickCap, true);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("click", onClickCap, true);
    };
  }, [depMode, byId, addDependency, canLink, setConnectDrag]);

  // Schedule mode: drag a node onto the timeline to set its SCHEDULED date+
  // time. We use NATIVE capture-phase pointer events (not HTML5 drag-and-
  // drop) because HTML5 dnd does not fire reliably inside Tauri's WKWebView.
  // The drop position is resolved by the TimelineBand, which listens for the
  // events we dispatch here and converts X→date, Y→time.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onDown = (e: PointerEvent) => {
      if (!scheduleMode || e.button !== 0) return;
      const nodeEl = (e.target as HTMLElement).closest(".react-flow__node") as HTMLElement | null;
      const nodeId = nodeEl?.getAttribute("data-id");
      if (!nodeEl || !nodeId) return; // empty pane → let React Flow pan
      e.preventDefault();
      e.stopPropagation();
      setScheduleDragNode(nodeId);
      let moved = false;
      const move = (ev: PointerEvent) => {
        moved = true;
        window.dispatchEvent(
          new CustomEvent("orggui:scheduleDragMove", {
            detail: { nodeId, x: ev.clientX, y: ev.clientY },
          }),
        );
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setScheduleDragNode(null);
        // A no-move click shouldn't schedule (and the TimelineBand ignores
        // drops outside the rail anyway).
        if (moved) {
          window.dispatchEvent(
            new CustomEvent("orggui:scheduleDrop", {
              detail: { nodeId, x: ev.clientX, y: ev.clientY },
            }),
          );
        }
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
    // Swallow node clicks while in schedule mode so the drag owns the surface.
    const onClickCap = (e: MouseEvent) => {
      if (scheduleMode && (e.target as HTMLElement).closest(".react-flow__node")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    el.addEventListener("pointerdown", onDown, true);
    el.addEventListener("click", onClickCap, true);
    return () => {
      el.removeEventListener("pointerdown", onDown, true);
      el.removeEventListener("click", onClickCap, true);
    };
  }, [scheduleMode, setScheduleDragNode]);

  // Cross-component focus: the TimelineBand dispatches "orggui:focusNode" when
  // a date tick is double-clicked. Pan the React Flow viewport to that node and
  // trigger a brief flash highlight so the eye finds it.
  useEffect(() => {
    const onFocus = (e: Event) => {
      const ce = e as CustomEvent<{ id: string }>;
      const id = ce.detail?.id;
      if (!id) return;
      const node = rf.getNode(id);
      if (!node) return;
      const w = (node.width ?? node.measured?.width ?? 220);
      const h = (node.height ?? node.measured?.height ?? 60);
      const cx = node.position.x + w / 2;
      const cy = node.position.y + h / 2;
      rf.setCenter(cx, cy, { duration: 450, zoom: Math.max(rf.getZoom(), 0.9) });
      select(id);
      flashNode(id);
    };
    window.addEventListener("orggui:focusNode", onFocus as EventListener);
    return () => window.removeEventListener("orggui:focusNode", onFocus as EventListener);
  }, [rf, select, flashNode]);

  if (!doc) return null;

  const descendantsOf = (id: string): string[] => {
    const out: string[] = [];
    const stack = [...(childMap.get(id) || [])];
    while (stack.length) {
      const c = stack.pop()!;
      out.push(c);
      const cc = childMap.get(c);
      if (cc) stack.push(...cc);
    }
    return out;
  };

  // A valid drop target: another header at the SAME level as the child's
  // current parent (so the child keeps its depth), not self/descendant/parent.
  const findTarget = (node: Node, ds: Extract<DragState, { kind: "child" }>): Node | null => {
    const inter = rf.getIntersectingNodes(node);
    return (
      inter.find(
        (nd) =>
          nd.type === "org" &&
          nd.id !== node.id &&
          nd.id !== ds.parentId &&
          !ds.descSet.has(nd.id) &&
          byId.get(nd.id)?.level === ds.parentLevel,
      ) ?? null
    );
  };

  return (
    <div ref={wrapRef} style={{ width: "100%", height: "100%", position: "relative" }}>
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onPaneClick={() => select(null)}
      onNodeDragStart={(_e, node) => {
        const org = byId.get(node.id);
        if (!org) return;
        if (!org.parent) {
          const descIds = new Set(descendantsOf(node.id));
          const desc = nodes
            .filter((nd) => descIds.has(nd.id))
            .map((nd) => ({ id: nd.id, sx: nd.position.x, sy: nd.position.y }));
          dragRef.current = { kind: "root", id: node.id, sx: node.position.x, sy: node.position.y, desc };
        } else {
          const sibs = nodes
            .filter((nd) => byId.get(nd.id)?.parent === org.parent)
            .map((nd) => ({ id: nd.id, y: nd.position.y }))
            .sort((a, b) => a.y - b.y);
          dragRef.current = {
            kind: "child",
            id: node.id,
            startX: node.position.x,
            sibs,
            origIndex: sibs.findIndex((s) => s.id === node.id),
            parentId: org.parent,
            parentLevel: byId.get(org.parent)?.level ?? 1,
            descSet: new Set(descendantsOf(node.id)),
          };
        }
      }}
      onNodeDrag={(_e, node) => {
        const ds = dragRef.current;
        if (!ds || ds.id !== node.id) return;
        if (ds.kind === "root") {
          const dx = node.position.x - ds.sx;
          const dy = node.position.y - ds.sy;
          setNodes((nds) =>
            nds.map((nd) => {
              const e = ds.desc.find((d) => d.id === nd.id);
              return e ? { ...nd, position: { x: e.sx + dx, y: e.sy + dy } } : nd;
            }),
          );
        } else {
          const t = findTarget(node, ds);
          setDropTarget(t ? t.id : null);
        }
      }}
      onNodeDragStop={(_e, node) => {
        const ds = dragRef.current;
        dragRef.current = null;
        if (!ds) return;
        if (ds.kind === "root") {
          const idx = rootIndexById.get(node.id);
          if (idx !== undefined) setRootPosition(idx, node.position.x, node.position.y);
          return;
        }
        const org = byId.get(node.id);
        const t = findTarget(node, ds);
        setDropTarget(null);
        if (t && org) {
          const tgt = byId.get(t.id);
          if (tgt) {
            refile(org, tgt.begin);
            return;
          }
        }
        // No re-parent: reorder among siblings if it stayed in its column.
        const dx = node.position.x - ds.startX;
        if (Math.abs(dx) < INDENT_X) {
          const others = ds.sibs.filter((s) => s.id !== node.id);
          const targetIndex = others.filter((s) => s.y < node.position.y).length;
          const delta = targetIndex - ds.origIndex;
          if (delta !== 0 && org) {
            reorder(org, delta);
            return;
          }
        }
        if (layout) setNodes(layout.nodes); // snap back
      }}
      nodesDraggable={!depMode && !scheduleMode}
      zoomOnDoubleClick={false}
      deleteKeyCode={null}
      fitView
      fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      minZoom={0.05}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: "tree" }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#2f2f31" />
      <TagAura />
      {depMode && (
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            zIndex: 6,
            background: "rgba(224,164,88,0.15)",
            border: "1px solid #e0a458",
            color: "#e0a458",
            padding: "4px 10px",
            borderRadius: 6,
            fontSize: 12,
            pointerEvents: "none",
          }}
        >
          Dependency mode — drag from a prerequisite node onto a dependent to link · click the ✕ on a link to remove
        </div>
      )}
      {/* Bottom-right cluster: zoom / fit-view controls just to the left of a
          compact, theme-matched minimap so the eye doesn't have to cross the
          canvas to find them. */}
      <Controls
        position="bottom-right"
        showInteractive={false}
        style={{ right: 158, bottom: 10 }}
      />
      <MiniMap
        position="bottom-right"
        pannable
        zoomable
        nodeColor={(n) => {
          if (n.type !== "org") return "transparent";
          const view = n.data as OrgNodeView;
          return levelColor(view.org?.level ?? 1);
        }}
        nodeStrokeColor="var(--c-border)"
        maskColor="rgba(0,0,0,0.55)"
        style={{
          width: 140,
          height: 92,
          background: "var(--c-surface)",
          border: "1px solid var(--c-border)",
          borderRadius: 6,
          right: 10,
          bottom: 10,
        }}
      />
      <SelectionBar />
    </ReactFlow>
      {tmpLine &&
        (() => {
          const color = tmpLine.valid ? "#98be65" : "#e0a458"; // green when a valid drop, amber otherwise
          return (
            <svg
              style={{ position: "fixed", left: 0, top: 0, width: "100vw", height: "100vh", pointerEvents: "none", zIndex: 9999, overflow: "visible" }}
            >
              <defs>
                <marker id="dep-tmp-arrow" markerWidth="10" markerHeight="8" refX="8" refY="3" orient="auto">
                  <path d="M0,0 L8,3 L0,6 Z" fill={color} />
                </marker>
              </defs>
              <line
                x1={tmpLine.x1}
                y1={tmpLine.y1}
                x2={tmpLine.x2}
                y2={tmpLine.y2}
                stroke={color}
                strokeWidth={2.5}
                strokeDasharray="6 4"
                markerEnd="url(#dep-tmp-arrow)"
              />
            </svg>
          );
        })()}
    </div>
  );
}
