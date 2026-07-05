/*
 * Datum Brain — cosmic-organism 3D graph view for Obsidian.
 * Design language: nebula fbm dome, UnrealBloom, gold breathing core,
 * procedural shader planets for hub notes, instanced lit spheres for notes,
 * twinkling dust for orphans, dark-glass chrome.
 *
 * Live data: graph derives from metadataCache.resolvedLinks, so it always
 * reflects the vault. Click a node to read it; "Open note" jumps to the editor.
 */
import { Plugin, ItemView, MarkdownRenderer, debounce } from "obsidian";
import * as T from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

export const VIEW_TYPE = "datum-brain-view";

/* ---------- palette: jewel tones in the Datum family ---------- */
const PALETTE = ["#E0A94E","#A56BE0","#4FA3FF","#5EC9A8","#E06B8B","#8AA0C0","#D98A45","#7FB6E8",
"#C9A05A","#9D8BE8","#5FB4C9","#C97BC0","#8FBF6E","#E0C36B","#6E8FE0","#C98A7B","#72C9A0","#B295D9",
"#D9A895","#84A9D9","#A8C972","#D97BA0","#95C9C0","#D9B884"];
const gcol = (i) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length];

const NOISE = `
float hash(vec3 p){p=fract(p*0.3183099+0.1);p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float vnoise(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.0-2.0*f);
 return mix(mix(mix(hash(i+vec3(0.,0.,0.)),hash(i+vec3(1.,0.,0.)),f.x),
                mix(hash(i+vec3(0.,1.,0.)),hash(i+vec3(1.,1.,0.)),f.x),f.y),
            mix(mix(hash(i+vec3(0.,0.,1.)),hash(i+vec3(1.,0.,1.)),f.x),
                mix(hash(i+vec3(0.,1.,1.)),hash(i+vec3(1.,1.,1.)),f.x),f.y),f.z);}
float fbm(vec3 p){float v=0.0,a=0.5;for(int i=0;i<5;i++){v+=a*vnoise(p);p*=2.02;a*=0.5;}return v;}
float warp(vec3 p){vec3 q=vec3(fbm(p),fbm(p+vec3(5.2,1.3,2.1)),fbm(p+vec3(1.7,9.2,3.3)));return fbm(p+4.0*q);}
`;

function mulberry32(seed){ let a = seed>>>0; return () => { a|=0; a=(a+0x6d2b79f5)|0;
  let t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; }; }
const hashStr = (s) => { let h=2166136261>>>0; for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);} return h>>>0; };

export default class DatumBrainPlugin extends Plugin {
  async onload(){
    this.registerView(VIEW_TYPE, (leaf) => new DatumBrainView(leaf));
    this.addRibbonIcon("orbit", "Open Datum Brain", () => this.activateView());
    this.addCommand({ id: "open-datum-brain", name: "Open Datum Brain", callback: () => this.activateView() });
  }
  async activateView(){
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf){
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}

class DatumBrainView extends ItemView {
  constructor(leaf){
    super(leaf);
    this.navigation = true;
    this._raf = 0;
    this._disposers = [];
  }
  getViewType(){ return VIEW_TYPE; }
  getDisplayText(){ return "Datum Brain"; }
  getIcon(){ return "orbit"; }

  async onOpen(){
    this.contentEl.empty();
    this.root = this.contentEl.createDiv({ cls: "db-root" });
    this.buildGraph();
    this.buildDom();
    this.buildScene();
    this.startLoop();
    /* live topology sync: rebuild (debounced) when the vault's link graph changes */
    const resync = debounce(() => this.resync(), 3000, true);
    this.registerEvent(this.app.metadataCache.on("resolved", resync));
  }

  async onClose(){
    cancelAnimationFrame(this._raf);
    this._disposers.forEach((fn) => { try { fn(); } catch(e){} });
    this._disposers = [];
    this.contentEl.empty();
  }

  /* =================== data: live from the vault =================== */
  groupFor(path){
    const parts = path.split("/");
    if (parts.length === 1) return "root";
    if (parts[0] === "_brain" && parts.length >= 3) return "_brain / " + parts[1];
    return parts[0];
  }

  buildGraph(){
    const files = this.app.vault.getMarkdownFiles();
    const resolved = this.app.metadataCache.resolvedLinks;
    const byPath = new Map();
    const groupsSet = new Set();
    const nodes = [];
    for (const f of files){
      const g = this.groupFor(f.path);
      groupsSet.add(g);
      const n = { id: f.path, file: f, t: f.basename, gname: g,
        w: Math.round((f.stat.size || 0) / 6), m: f.stat.mtime,
        d: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
      byPath.set(f.path, n); nodes.push(n);
    }
    this.groups = [...groupsSet].sort();
    const gIdx = new Map(this.groups.map((g, i) => [g, i]));
    nodes.forEach((n) => { n.g = gIdx.get(n.gname); });

    const links = [];
    const seen = new Set();
    for (const src in resolved){
      const a = byPath.get(src);
      if (!a) continue;
      for (const dst in resolved[src]){
        const b = byPath.get(dst);
        if (!b || a === b) continue;
        const key = a.id < b.id ? a.id + "\n" + b.id : b.id + "\n" + a.id;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ s: a, t: b, type: "read" });
      }
    }
    const adj = new Map(nodes.map((n) => [n.id, new Set()]));
    const backlinks = new Map(nodes.map((n) => [n.id, []]));
    for (const l of links){
      l.s.d++; l.t.d++;
      adj.get(l.s.id).add(l.t.id); adj.get(l.t.id).add(l.s.id);
      backlinks.get(l.t.id).push(l.s.id);
    }

    /* tiers: planets for the strongest hubs, dust for orphans, spheres for the rest */
    const sorted = nodes.slice().sort((a, b) => b.d - a.d);
    const hubCount = Math.max(6, Math.min(22, Math.round(nodes.length / 18)));
    this.HUBS = new Set(sorted.filter((n) => n.d >= 8).slice(0, hubCount).map((n) => n.id));
    nodes.forEach((n) => { n.kind = this.HUBS.has(n.id) ? "hub" : (n.d === 0 ? "star" : "orb"); });

    /* virtual gold core wired to each system's strongest node */
    const core = { id: "__core", t: this.app.vault.getName(), kind: "core", g: -1, d: 0,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, fixed: true, w: 0, m: 0 };
    const topByGroup = new Map();
    for (const n of sorted) if (!topByGroup.has(n.g) && n.d > 0) topByGroup.set(n.g, n);
    this.coreLinks = [...topByGroup.values()].map((t) => ({ s: core, t, type: "core" }));

    this.nodes = nodes; this.core = core;
    this.ALL = nodes.concat([core]);
    this.links = links;
    this.ALL_LINKS = links.concat(this.coreLinks);
    this.byId = byPath; this.adj = adj; this.backlinks = backlinks;

    /* seed positions: each system radiates from a fibonacci direction */
    const dirs = [];
    for (let i = 0; i < this.groups.length; i++){
      const phi = Math.acos(1 - 2 * (i + .5) / this.groups.length), th = Math.PI * (1 + Math.sqrt(5)) * i;
      dirs.push([Math.sin(phi) * Math.cos(th), Math.cos(phi) * .6, Math.sin(phi) * Math.sin(th)]);
    }
    const R0 = 120 + nodes.length * .12;
    nodes.forEach((n) => {
      const rng = mulberry32(hashStr(n.id));
      const d = dirs[n.g] || [1, 0, 0];
      const r = R0 * (.55 + rng() * .75);
      n.x = d[0] * r + (rng() - .5) * 55; n.y = d[1] * r + (rng() - .5) * 55; n.z = d[2] * r + (rng() - .5) * 55;
    });

    this.hiddenGroups = new Set();
    this.hiddenKinds = this.hiddenKinds || new Set();
    this.layoutMode = this.layoutMode || "radial";
    this.showAllLabels = false;
    this.alpha = 1;
    this.hover = null; this.selected = null;
    this.focusedGroup = null;
    this.sectorInfo = [];
    this.ringRadii = [];
    this.layoutExtent = 300;
    if (this.layoutMode === "radial"){
      this.computeRadial();
      for (const n of this.ALL){ if (n.tx !== undefined){ n.x = n.tx; n.y = n.ty; n.z = n.tz; } }
    } else {
      for (let i = 0; i < 180; i++) this.tick();
    }
    this.alpha = .28;
  }

  kindKey(n){
    return n.kind === "hub" ? "world" : n.kind === "star" ? "orphan" : n.d >= 10 ? "connector" : "note";
  }

  /* cluster-island layout: each system gets its own separated space */
  computeRadial(){
    this.sectorInfo.length = 0;
    this.ringRadii = this.ringRadii || [];
    this.ringRadii.length = 0;
    const act = this.nodes.filter((n) => this.visible(n));
    const byG = new Map();
    act.forEach((n) => { if (!byG.has(n.g)) byG.set(n.g, []); byG.get(n.g).push(n); });
    if (!byG.size){ this.layoutExtent = 200; this.applyRings(); return; }
    const jitterY = (id) => ((hashStr(id + "y") % 1000) / 1000 - .5) * 16;
    const rank = (n) => n.kind === "hub" ? 0 : n.d === 0 ? 3 : n.d >= 10 ? 1 : 2;
    /* 1) local island layout: hub center, notes in rings around it */
    const islands = [];
    for (const [g, members] of byG){
      members.sort((a, b) => rank(a) - rank(b) || b.d - a.d);
      const hubs = members.filter((n) => n.kind === "hub");
      const rest = members.filter((n) => n.kind !== "hub");
      const local = new Map();
      hubs.forEach((n, i) => {
        if (hubs.length === 1) local.set(n, [0, 0]);
        else { const a = i / hubs.length * Math.PI * 2; local.set(n, [Math.cos(a) * 16, Math.sin(a) * 16]); }
      });
      let r = hubs.length ? 30 : 14, i = 0;
      const a0 = (hashStr(this.groups[g] || String(g)) % 628) / 100;
      while (i < rest.length){
        const per = Math.max(4, Math.floor(Math.PI * 2 * r / 12));
        const count = Math.min(per, rest.length - i);
        for (let k = 0; k < count; k++, i++){
          const a = a0 + k / count * Math.PI * 2;
          local.set(rest[i], [Math.cos(a) * r, Math.sin(a) * r]);
        }
        r += 18;
      }
      islands.push({ g, local, r: Math.max(r - 18, 14) + 10 });
    }
    /* 2) pack islands onto concentric orbit rings with generous gaps */
    islands.sort((a, b) => b.r - a.r);
    let prevOuter = 55, idx = 0;
    while (idx < islands.length){
      const rMax = islands[idx].r;
      const R = prevOuter + rMax + 55;
      const ring = [];
      let used = 0;
      while (idx < islands.length){
        const w = 2 * Math.asin(Math.min(.95, (islands[idx].r + 26) / R));
        if (ring.length && used + w > Math.PI * 2) break;
        ring.push([islands[idx], w]); used += w; idx++;
      }
      this.ringRadii.push(R);
      const slack = Math.max(0, (Math.PI * 2 - used) / ring.length);
      let theta = -Math.PI / 2 + (this.ringRadii.length - 1) * .7;
      for (const [isl, w] of ring){
        const midA = theta + (w + slack) / 2;
        const cx = Math.cos(midA) * R, cz = Math.sin(midA) * R;
        for (const [n, lp] of isl.local){
          n.tx = cx + lp[0]; n.tz = cz + lp[1];
          n.ty = jitterY(n.id) * (n.kind === "hub" ? .3 : 1);
        }
        this.sectorInfo.push({ g: isl.g, cx, cz, r: isl.r });
        theta += w + slack;
      }
      prevOuter = R + rMax;
    }
    this.layoutExtent = prevOuter;
    this.core.tx = this.core.ty = this.core.tz = 0;
    this.applyRings();
  }

  applyRings(){
    if (!this.orbitRings) return;
    this.orbitRings.forEach((m, i) => {
      const R = this.ringRadii[i];
      m.visible = this.layoutMode === "radial" && !!R;
      if (R) m.scale.setScalar(R);
    });
    this.islandRings.forEach((m, gi) => {
      const s = this.sectorInfo.find((x) => x.g === gi);
      m.visible = this.layoutMode === "radial" && !!s;
      if (s){ m.position.set(s.cx, 0, s.cz); m.scale.setScalar(s.r + 10); }
    });
  }

  /* drill into a cluster: camera dives in, everything else recedes */
  enterCluster(g){
    const s = this.sectorInfo.find((x) => x.g === g);
    if (!s) return;
    this.focusedGroup = g;
    this.controls.autoRotate = false;
    const d = Math.max(70, s.r * 2.7);
    this.flyTarget = { tx: s.cx, ty: 0, tz: s.cz, cx: s.cx, cy: d * .8, cz: s.cz + d * .75 };
    if (this.zEl){ this.zEl.setText((this.groups[g] || "").replace(/^_brain \/ /, "").toLowerCase()); this._lastZ = "__cluster"; }
  }
  exitCluster(){ this.goHome(); }

  relayout(){
    if (this.layoutMode === "radial") this.computeRadial();
    else this.alpha = Math.max(this.alpha, .3);
  }

  setLayout(m){
    this.layoutMode = m;
    if (this.bLayout) this.bLayout.setText(m === "radial" ? "Orbit view" : "Cluster view");
    if (m === "radial") this.computeRadial(); else this.alpha = 1;
    this.applyRings();
    this.goHome();
  }

  radius(n){
    return n.kind === "core" ? 13 : n.kind === "hub" ? 4.2 + Math.sqrt(n.d) * .55
      : n.kind === "star" ? 1.5 : 1.6 + Math.sqrt(n.d) * .42 + Math.min(n.w || 0, 2400) / 2400 * 1.1;
  }
  visible(n){
    return n.kind === "core" || (!this.hiddenGroups.has(n.g) && !this.hiddenKinds.has(this.kindKey(n)));
  }

  tick(){
    if (this.alpha < .004) return;
    const rep = 1750, spring = .03, grav = .012, damp = .85;
    const act = this.ALL.filter((n) => this.visible(n));
    for (let i = 0; i < act.length; i++){
      const a = act[i];
      for (let j = i + 1; j < act.length; j++){
        const b = act[j];
        let dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 68644) continue;
        if (d2 < 1){ dx = Math.random() - .5; dy = Math.random() - .5; dz = Math.random() - .5; d2 = 1; }
        const f = rep / d2 * this.alpha, inv = 1 / Math.sqrt(d2);
        dx *= inv; dy *= inv; dz *= inv;
        a.vx += dx * f; a.vy += dy * f; a.vz += dz * f; b.vx -= dx * f; b.vy -= dy * f; b.vz -= dz * f;
      }
    }
    for (const l of this.ALL_LINKS){
      if (!this.visible(l.s) || !this.visible(l.t)) continue;
      let dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, dz = l.t.z - l.s.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const rest = l.type === "core" ? 112 : 46;
      const f = (d - rest) * spring * this.alpha;
      dx /= d; dy /= d; dz /= d;
      l.s.vx += dx * f; l.s.vy += dy * f; l.s.vz += dz * f; l.t.vx -= dx * f; l.t.vy -= dy * f; l.t.vz -= dz * f;
    }
    for (const n of act){
      n.vx -= n.x * grav * this.alpha; n.vy -= n.y * grav * this.alpha * 1.25; n.vz -= n.z * grav * this.alpha;
      if (n.fixed){ n.vx = n.vy = n.vz = 0; continue; }
      n.vx *= damp; n.vy *= damp; n.vz *= damp;
      n.x += n.vx; n.y += n.vy; n.z += n.vz;
    }
    this.alpha *= .996;
  }

  /* =================== chrome =================== */
  buildDom(){
    const root = this.root;
    this.stageEl = root.createDiv({ cls: "db-stage" });
    this.labelWrap = root.createDiv({ cls: "db-labels" });

    const hdr = root.createDiv({ cls: "db-hdr" });
    hdr.createSpan({ cls: "db-ey", text: "Datum · Knowledge Organism" });
    const h1 = hdr.createEl("h1");
    h1.appendText("Vault ");
    h1.createEl("b", { text: "Brain" });

    /* left rail */
    this.sideEl = root.createDiv({ cls: "db-side db-card" });
    const sw = this.sideEl.createDiv({ cls: "db-searchwrap" });
    this.searchEl = sw.createEl("input", { cls: "db-search", attr: { placeholder: "search the organism  ( / )", spellcheck: "false" } });
    this.resultsEl = sw.createDiv({ cls: "db-results" });
    this.sideEl.createDiv({ cls: "db-k", text: "Node types" });
    this.ntypesEl = this.sideEl.createDiv({ cls: "db-groups db-ntypes" });
    this.sideEl.createDiv({ cls: "db-k", text: "Systems" });
    this.groupsEl = this.sideEl.createDiv({ cls: "db-groups" });
    const ctl = this.sideEl.createDiv({ cls: "db-controls" });
    const btn = (label, cls) => ctl.createEl("button", { cls: "db-btn" + (cls ? " " + cls : ""), text: label });
    const bHome = btn("Home", "db-gold"), bLayout = btn("Orbit view"), bReheat = btn("Retidy"),
          bLabels = btn("Labels"), bSync = btn("Sync");
    this.bLayout = bLayout;
    this.statsEl = this.sideEl.createDiv({ cls: "db-stats" });

    /* reader */
    this.readerEl = root.createDiv({ cls: "db-reader db-card" });
    const rh = this.readerEl.createDiv({ cls: "db-rhead" });
    this.rClose = rh.createEl("button", { cls: "db-rclose", text: "✕" });
    this.rTitle = rh.createDiv({ cls: "db-rtitle" });
    this.rMeta = rh.createDiv({ cls: "db-rmeta" });
    const ra = rh.createDiv({ cls: "db-ractions" });
    this.bOpen = ra.createEl("button", { cls: "db-btn db-gold", text: "Open note" });
    this.bFocus = ra.createEl("button", { cls: "db-btn", text: "Focus" });
    this.rBody = this.readerEl.createDiv({ cls: "db-rbody" });
    this.rBacks = this.readerEl.createDiv({ cls: "db-backs" });

    /* HUD */
    const hud = root.createDiv({ cls: "db-hud" });
    this.orbBtn = hud.createEl("button", { cls: "db-orb", attr: { title: "home" } });
    const hudTxt = hud.createDiv();
    this.zEl = hudTxt.createDiv({ cls: "db-z", text: "organism" });
    const hint = hudTxt.createDiv({ cls: "db-h" });
    hint.innerHTML = "<b>click</b> a world or name to enter its system &middot; <b>Esc</b> zooms out &middot; <b>/</b> search";

    this.buildTypeRows();
    this.buildChips();
    this.updateStats();

    bHome.onclick = () => { this.clearSel(); this.goHome(); };
    this.orbBtn.onclick = () => { this.clearSel(); this.goHome(); };
    bLayout.onclick = () => this.setLayout(this.layoutMode === "radial" ? "orbit" : "radial");
    bReheat.onclick = () => { if (this.layoutMode === "radial") this.computeRadial(); else this.alpha = 1; };
    bLabels.onclick = () => { this.showAllLabels = !this.showAllLabels; bLabels.classList.toggle("db-on"); };
    bSync.onclick = () => this.resync();
    this.rClose.onclick = () => { this.clearSel(); };
    this.bFocus.onclick = () => { if (this.selected) this.flyTo(this.selected); };
    this.bOpen.onclick = () => {
      if (this.selected && this.selected.file) this.app.workspace.getLeaf("tab").openFile(this.selected.file);
    };

    /* search */
    this.curMatches = []; this.selIdx = -1;
    this.searchEl.addEventListener("input", () => this.doSearch(this.searchEl.value));
    this.searchEl.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp"){
        e.preventDefault();
        this.selIdx = Math.max(0, Math.min(this.curMatches.length - 1, this.selIdx + (e.key === "ArrowDown" ? 1 : -1)));
        [...this.resultsEl.children].forEach((c, i) => c.classList.toggle("db-sel", i === this.selIdx));
      } else if (e.key === "Enter" && this.curMatches.length){
        this.select(this.curMatches[Math.max(0, this.selIdx)]);
        this.resultsEl.style.display = "none"; this.searchEl.blur();
      } else if (e.key === "Escape"){ this.resultsEl.style.display = "none"; this.searchEl.blur(); }
    });
    this.registerDomEvent(this.root, "keydown", (e) => {
      if (e.key === "/" && document.activeElement !== this.searchEl){
        e.preventDefault(); this.searchEl.focus(); this.searchEl.select();
      }
      if (e.key === "Escape" && document.activeElement !== this.searchEl){
        if (this.readerEl.classList.contains("db-open")) this.clearSel();
        else if (this.focusedGroup != null) this.exitCluster();
      }
    });
    this.root.tabIndex = -1;
    this.registerDomEvent(this.root, "pointerdown", (e) => {
      if (!e.target.closest(".db-searchwrap")) this.resultsEl.style.display = "none";
    });
    /* internal links inside the reader select the node in the brain; mod-click opens the editor */
    this.registerDomEvent(this.rBody, "click", (e) => {
      const a = e.target.closest("a.internal-link");
      if (!a) return;
      e.preventDefault(); e.stopPropagation();
      const href = a.getAttribute("data-href") || a.getAttribute("href");
      if (!href) return;
      const f = this.app.metadataCache.getFirstLinkpathDest(href, this.selected ? this.selected.id : "");
      if (!f) return;
      if (e.metaKey || e.ctrlKey){ this.app.workspace.getLeaf("tab").openFile(f); return; }
      const n = this.byId.get(f.path);
      if (n) this.select(n); else this.app.workspace.getLeaf("tab").openFile(f);
    });
    this.registerDomEvent(this.rBacks, "click", (e) => {
      const el = e.target.closest("[data-id]");
      if (el && this.byId.has(el.dataset.id)) this.select(this.byId.get(el.dataset.id));
    });
  }

  buildTypeRows(){
    this.ntypesEl.empty();
    const KINDS = [
      ["world", "Worlds", "#E0A94E"],
      ["connector", "Connectors", "#8AA0C0"],
      ["note", "Notes", "#5d6b8a"],
      ["orphan", "Orphans", "#4a5266"],
    ];
    const kCounts = {};
    this.nodes.forEach((n) => { const k = this.kindKey(n); kCounts[k] = (kCounts[k] || 0) + 1; });
    for (const [key, label, col] of KINDS){
      const d = this.ntypesEl.createDiv({ cls: "db-chip" + (this.hiddenKinds.has(key) ? " db-off" : "") });
      const dot = d.createSpan({ cls: "db-dot" });
      dot.style.background = col; dot.style.color = col;
      d.createSpan({ text: label });
      d.createSpan({ cls: "db-n", text: String(kCounts[key] || 0) });
      d.onclick = () => {
        this.hiddenKinds.has(key) ? this.hiddenKinds.delete(key) : this.hiddenKinds.add(key);
        d.classList.toggle("db-off");
        this.relayout(); this.updateStats();
      };
    }
  }

  buildChips(){
    this.groupsEl.empty();
    const counts = {};
    this.nodes.forEach((n) => { counts[n.g] = (counts[n.g] || 0) + 1; });
    this.groups.forEach((g, i) => {
      const d = this.groupsEl.createDiv({ cls: "db-chip" + (this.hiddenGroups.has(i) ? " db-off" : "") });
      const dot = d.createSpan({ cls: "db-dot" });
      dot.style.background = gcol(i); dot.style.color = gcol(i);
      d.createSpan({ text: g });
      d.createSpan({ cls: "db-n", text: String(counts[i] || 0) });
      d.onclick = () => {
        this.hiddenGroups.has(i) ? this.hiddenGroups.delete(i) : this.hiddenGroups.add(i);
        d.classList.toggle("db-off");
        this.relayout(); this.updateStats();
      };
    });
  }

  updateStats(){
    const vis = this.nodes.filter((n) => this.visible(n)).length;
    const vl = this.links.filter((l) => this.visible(l.s) && this.visible(l.t)).length;
    this.statsEl.setText(`${vis} / ${this.nodes.length} notes · ${vl} / ${this.links.length} links · ${this.HUBS.size} worlds`);
  }

  doSearch(q){
    q = q.trim().toLowerCase();
    if (!q){ this.resultsEl.style.display = "none"; return; }
    const scored = [];
    for (const n of this.nodes){
      const t = n.t.toLowerCase(), p = n.id.toLowerCase();
      const cache = this.app.metadataCache.getFileCache(n.file);
      const tags = (cache && cache.tags ? cache.tags.map((x) => x.tag.toLowerCase()) : []);
      let s = -1;
      if (t === q) s = 100; else if (t.startsWith(q)) s = 80; else if (t.includes(q)) s = 60;
      else if (p.includes(q)) s = 40; else if (tags.some((x) => x.includes(q))) s = 30;
      if (s >= 0) scored.push([s + Math.min(n.d, 20) * .5, n]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    this.curMatches = scored.slice(0, 12).map((x) => x[1]);
    this.selIdx = -1;
    this.resultsEl.empty();
    for (const n of this.curMatches){
      const r = this.resultsEl.createDiv({ cls: "db-r" });
      const b = r.createEl("b", { text: "● " }); b.style.color = gcol(n.g);
      r.createEl("b", { text: n.t });
      r.createSpan({ text: n.id });
      r.onclick = () => { this.select(n); this.resultsEl.style.display = "none"; };
    }
    this.resultsEl.style.display = this.curMatches.length ? "block" : "none";
  }

  async select(n, keepCam){
    this.selected = n;
    if (this.layoutMode === "radial" && this.focusedGroup != null && n.g !== this.focusedGroup) this.focusedGroup = n.g;
    this.spawnParticles(n);
    this.rTitle.setText(n.t);
    const dt = new Date(n.m).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    this.rMeta.empty();
    const sys = this.rMeta.createSpan({ text: "● " + (this.groups[n.g] || "") });
    sys.style.color = gcol(n.g);
    this.rMeta.createSpan({ text: "· " + n.id });
    this.rMeta.createSpan({ text: "· " + dt });
    this.rBody.empty();
    if (n.file){
      const md = await this.app.vault.cachedRead(n.file);
      await MarkdownRenderer.render(this.app, md, this.rBody, n.id, this);
    }
    const bl = this.backlinks.get(n.id) || [];
    this.rBacks.empty();
    this.rBacks.createDiv({ cls: "db-bk", text: bl.length ? `↩ ${bl.length} backlink${bl.length > 1 ? "s" : ""}` : "no backlinks" });
    for (const id of bl){
      const d = this.rBacks.createDiv({ cls: "db-b", text: this.byId.get(id).t });
      d.dataset.id = id;
    }
    this.readerEl.classList.add("db-open");
    this.rBody.scrollTop = 0;
    if (!keepCam) this.flyTo(n);
  }

  clearSel(){
    this.selected = null; this.killParticles();
    this.readerEl.classList.remove("db-open");
  }

  async resync(){
    const selId = this.selected ? this.selected.id : null;
    const cam = this.camera ? this.camera.position.clone() : null;
    const tgt = this.controls ? this.controls.target.clone() : null;
    this.teardownScene();
    this.labelWrap.empty();
    this.buildGraph();
    this.buildTypeRows();
    this.buildChips();
    this.updateStats();
    this.buildScene();
    if (cam && tgt){ this.camera.position.copy(cam); this.controls.target.copy(tgt); }
    if (selId && this.byId.has(selId)) this.select(this.byId.get(selId), true);
  }

  /* =================== scene =================== */
  buildScene(){
    const stage = this.stageEl;
    let W = Math.max(1, stage.clientWidth), H = Math.max(1, stage.clientHeight);
    this.W = W; this.H = H;

    const scene = this.scene = new T.Scene();
    const camera = this.camera = new T.PerspectiveCamera(55, W / H, .1, 8000);
    if (this.layoutMode === "radial") camera.position.set(0, this.layoutExtent * 1.1 + 130, this.layoutExtent * 1.15 + 150);
    else camera.position.set(0, 40, 260);
    const renderer = this.renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(W, H);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.setClearColor(0x05060a, 1);
    stage.appendChild(renderer.domElement);

    scene.fog = new T.FogExp2(0x05060a, .0015);
    scene.add(new T.AmbientLight(0x8fa2c8, .55));
    scene.add(new T.PointLight(0xE0A94E, 2.6, 0, 0));
    const fill = new T.DirectionalLight(0x9fb6e8, .75);
    fill.position.set(240, 180, 160);
    scene.add(fill);

    const controls = this.controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = .06;
    controls.minDistance = 30; controls.maxDistance = 1800;
    controls.autoRotate = true; controls.autoRotateSpeed = .35;

    const composer = this.composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new T.Vector2(W, H), .45, .5, .3);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    this.clock = new T.Clock();
    const timeMats = this.timeMats = [];

    /* nebula dome */
    const domeMat = new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false, uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec3 vD;void main(){vD=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: NOISE + `varying vec3 vD;uniform float uTime;
       void main(){vec3 p=vD*2.2;float f=warp(p+vec3(uTime*0.015));
        vec3 base=vec3(0.02,0.03,0.06);
        vec3 c1=vec3(0.16,0.07,0.24);vec3 c2=vec3(0.05,0.13,0.22);vec3 c3=vec3(0.20,0.10,0.06);
        vec3 col=base;col=mix(col,c1,smoothstep(0.45,0.85,f));col=mix(col,c2,smoothstep(0.5,0.9,warp(p*1.4+9.0)));col=mix(col,c3,smoothstep(0.6,0.95,warp(p*0.8-4.0))*0.5);
        float star=step(0.9975,hash(floor(vD*900.0)));col+=vec3(star)*(0.30+0.2*sin(uTime*3.0+hash(floor(vD*300.0))*30.0));
        gl_FragColor=vec4(col*0.55,1.0);}`,
    });
    scene.add(new T.Mesh(new T.SphereGeometry(4200, 48, 32), domeMat));
    timeMats.push(domeMat);

    /* sprite textures */
    const glowTex = () => {
      const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d");
      const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(.25, "rgba(255,255,255,.75)");
      gr.addColorStop(.55, "rgba(255,255,255,.22)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new T.CanvasTexture(c);
    };
    const starTex = () => {
      const c = document.createElement("canvas"); c.width = c.height = 128; const g = c.getContext("2d"); const cx = 64;
      const gr = g.createRadialGradient(cx, cx, 0, cx, cx, 40);
      gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(.25, "rgba(255,255,255,.5)"); gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      const sp = (l, w, r) => { g.save(); g.translate(cx, cx); g.rotate(r);
        const lg = g.createLinearGradient(0, 0, 0, -l); lg.addColorStop(0, "rgba(255,255,255,.95)"); lg.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = lg; g.beginPath(); g.moveTo(-w, 0); g.lineTo(0, -l); g.lineTo(w, 0); g.closePath(); g.fill(); g.restore(); };
      sp(58, 4, 0); sp(58, 4, Math.PI); sp(58, 4, Math.PI / 2); sp(58, 4, -Math.PI / 2);
      sp(30, 3, Math.PI / 4); sp(30, 3, -Math.PI / 4); sp(30, 3, 3 * Math.PI / 4); sp(30, 3, -3 * Math.PI / 4);
      return new T.CanvasTexture(c);
    };
    const GLOW = this.GLOW = glowTex(), STAR = this.STAR = starTex();

    /* parallax dust */
    {
      const sfN = 900, sfPos = new Float32Array(sfN * 3);
      const rng = mulberry32(0xbeef);
      for (let i = 0; i < sfN; i++){
        const r = 500 + rng() * 1900, th = rng() * 6.283, ph = Math.acos(2 * rng() - 1);
        sfPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
        sfPos[i * 3 + 1] = r * Math.cos(ph) * .7;
        sfPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      }
      const sfGeo = new T.BufferGeometry();
      sfGeo.setAttribute("position", new T.BufferAttribute(sfPos, 3));
      scene.add(new T.Points(sfGeo, new T.PointsMaterial({ map: GLOW, color: 0x8ea6d8, size: 2.6,
        sizeAttenuation: true, transparent: true, opacity: .38, depthWrite: false, blending: T.AdditiveBlending })));
    }

    /* guide rings: unit circle scaled to orbit rings + one boundary ring per island */
    const circPts = [];
    for (let i = 0; i <= 96; i++){ const a = i / 96 * Math.PI * 2; circPts.push(new T.Vector3(Math.cos(a), 0, Math.sin(a))); }
    const unitCircle = new T.BufferGeometry().setFromPoints(circPts);
    const mkRing = (color, op) => {
      const m = new T.Line(unitCircle, new T.LineBasicMaterial({ color, transparent: true, opacity: op,
        blending: T.AdditiveBlending, depthWrite: false }));
      m.visible = false; scene.add(m); return m;
    };
    this.orbitRings = [0,1,2,3,4,5].map(() => mkRing(0x1a2440, .5));
    this.islandRings = this.groups.map(() => mkRing(0x243154, .5));
    this.applyRings();

    /* shaders */
    const planetMat = (hex, seed) => new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color(hex) }, uSeed: { value: seed }, uAct: { value: 0 } },
      vertexShader: `varying vec3 vP;varying vec3 vN;varying vec3 vV;void main(){vP=position;vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(position,1.0);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}`,
      fragmentShader: NOISE + `varying vec3 vP;varying vec3 vN;varying vec3 vV;uniform float uTime;uniform vec3 uColor;uniform float uSeed;uniform float uAct;
       void main(){vec3 p=normalize(vP)*2.4+vec3(uSeed);float f=warp(p+vec3(uTime*0.05));
        float bands=fbm(vec3(normalize(vP).y*4.0+uTime*0.04,uSeed,0.0));
        vec3 col=mix(uColor*0.22,uColor*0.80,f);
        col=mix(col,mix(uColor,vec3(1.0),0.35),smoothstep(0.6,0.96,bands)*0.35);
        float fres=pow(1.0-max(dot(normalize(vN),normalize(vV)),0.0),2.8);
        col+=uColor*fres*(0.5+uAct*1.0);
        col*=0.80+uAct*0.35;
        gl_FragColor=vec4(col,1.0);}`,
    });
    const ringMat = (hex, seed) => new T.ShaderMaterial({
      transparent: true, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color(hex) }, uSeed: { value: seed } },
      vertexShader: `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: NOISE + `varying vec2 vUv;uniform float uTime;uniform vec3 uColor;uniform float uSeed;
       void main(){vec2 d=vUv-0.5;float r=length(d)*2.0;float ang=atan(d.y,d.x);
        float band=fbm(vec3(r*7.0,ang*1.5+uTime*0.15,uSeed));
        float annulus=smoothstep(1.0,0.82,r)*smoothstep(0.55,0.72,r);
        float a=annulus*(0.35+0.65*band);
        gl_FragColor=vec4(uColor*(0.7+band*0.6),a*0.9);}`,
    });
    const datumMat = new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uA: { value: new T.Color("#E0A94E") }, uB: { value: new T.Color("#A56BE0") } },
      vertexShader: NOISE + `uniform float uTime;varying vec3 vN;varying vec3 vV;varying float vD;
       void main(){float d=warp(normalize(position)*2.2+uTime*0.25);vD=d;vec3 pos=position*(1.0+d*0.16*(0.85+0.15*sin(uTime*1.3)));vN=normalize(normalMatrix*normal);vec4 mv=modelViewMatrix*vec4(pos,1.0);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}`,
      fragmentShader: `varying vec3 vN;varying vec3 vV;varying float vD;uniform vec3 uA;uniform vec3 uB;
       void main(){float fres=pow(1.0-max(dot(normalize(vN),normalize(vV)),0.0),2.0);vec3 col=mix(uA,uB,smoothstep(0.2,0.85,vD));col+=vec3(1.0,0.92,0.7)*fres*1.6;gl_FragColor=vec4(col,1.0);}`,
    });
    timeMats.push(datumMat);

    const spriteOrb = (hex, size, op) => {
      const s = new T.Sprite(new T.SpriteMaterial({ map: GLOW, color: new T.Color(hex), transparent: true,
        opacity: op, blending: T.AdditiveBlending, depthWrite: false }));
      s.scale.setScalar(size); return s;
    };
    const pickables = this.pickables = [], pickMap = this.pickMap = [];
    const ORBS = this.ORBS = [];
    let ringFlip = false;
    for (const n of this.ALL){
      const col = n.kind === "core" ? "#E0A94E" : gcol(n.g);
      if (n.kind === "core"){
        const grp = new T.Group();
        n.body = new T.Mesh(new T.IcosahedronGeometry(this.radius(n), 24), datumMat);
        grp.add(n.body);
        grp.add(spriteOrb("#E0A94E", this.radius(n) * 6.2, .5));
        grp.add(spriteOrb("#A56BE0", this.radius(n) * 4.0, .4));
        scene.add(grp); n.mesh = grp;
      } else if (n.kind === "hub"){
        const grp = new T.Group(); const R = this.radius(n);
        const m = planetMat(col, (hashStr(n.id) % 1000) / 100); timeMats.push(m);
        n.body = new T.Mesh(new T.SphereGeometry(R, 40, 40), m); grp.add(n.body); n.pmat = m;
        n.atmo = spriteOrb(col, R * 3.0, .24); grp.add(n.atmo);
        ringFlip = !ringFlip;
        if (ringFlip){
          const rm = ringMat(col, (hashStr(n.id) % 700) / 70); timeMats.push(rm);
          n.ringM = new T.Mesh(new T.RingGeometry(R * 1.5, R * 3.1, 96), rm);
          n.ringM.rotation.x = Math.PI * .44; n.ringM.rotation.y = .28; grp.add(n.ringM);
        }
        grp.rotation.z = ((hashStr(n.id) % 100) / 100 - .5) * .9;
        scene.add(grp); n.mesh = grp;
      } else if (n.kind === "star"){
        const s = new T.Sprite(new T.SpriteMaterial({ map: STAR, color: new T.Color(col), transparent: true,
          opacity: .5, blending: T.AdditiveBlending, depthWrite: false }));
        s.scale.setScalar(this.radius(n) * 2.4); scene.add(s); n.mesh = s; n.tw = (hashStr(n.id) % 628) / 100;
      } else {
        n.orbIdx = ORBS.length; ORBS.push(n);
        if (n.d >= 10){ n.halo = spriteOrb(col, this.radius(n) * 2.8, .22); scene.add(n.halo); }
        continue;
      }
      pickables.push(n.body || n.mesh); pickMap.push(n);
    }
    const orbGeo = new T.SphereGeometry(1, 18, 18);
    const orbMat = new T.MeshStandardMaterial({ roughness: .5, metalness: .18 });
    const orbMesh = this.orbMesh = new T.InstancedMesh(orbGeo, orbMat, Math.max(1, ORBS.length));
    orbMesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    this.dummy = new T.Object3D(); this.cTmp = new T.Color();
    ORBS.forEach((n, i) => { this.cTmp.set(gcol(n.g)); orbMesh.setColorAt(i, this.cTmp); });
    scene.add(orbMesh);
    this.selHalo = spriteOrb("#E0A94E", 10, 0);
    scene.add(this.selHalo);

    /* links buffer */
    const SEG = this.SEG = 8;
    const nL = this.ALL_LINKS.length;
    const lPos = this.lPos = new Float32Array(Math.max(1, nL * SEG * 2 * 3));
    const lCol = this.lCol = new Float32Array(Math.max(1, nL * SEG * 2 * 3));
    const lGeo = this.lGeo = new T.BufferGeometry();
    lGeo.setAttribute("position", new T.BufferAttribute(lPos, 3));
    lGeo.setAttribute("color", new T.BufferAttribute(lCol, 3));
    scene.add(new T.LineSegments(lGeo, new T.LineBasicMaterial({ vertexColors: true, transparent: true,
      opacity: .7, blending: T.AdditiveBlending, depthWrite: false })));
    this.C_CORE = new T.Color(0x584422); this.C_HOT = new T.Color(0xE0A94E);
    this.C_HOT2 = new T.Color(0x4FA3FF); this.C_OFF = new T.Color(0x000000);
    for (const l of this.ALL_LINKS){
      if (l.type === "core"){ l.c = this.C_CORE; continue; }
      if (l.s.g === l.t.g){ l.c = new T.Color(gcol(l.s.g)).multiplyScalar(.18); continue; }
      const dom = l.s.d >= l.t.d ? l.s : l.t;
      l.c = new T.Color(gcol(dom.g)).multiplyScalar(.10);
    }
    this.up = new T.Vector3(0, 1, 0); this.tmpV = new T.Vector3(); this.perV = new T.Vector3();
    this.bz = { cx: 0, cy: 0, cz: 0 };
    this.hotColor = new T.Color();
    this.dimColor = new T.Color();
    this.pv = new T.Vector3(); this.wp = new T.Vector3();
    this.particles = [];
    this.flyTarget = null;

    /* labels */
    this.labelEls = new Map();
    for (const n of this.ALL){
      const d = this.labelWrap.createDiv({ cls: "db-lbl" + (n.kind === "core" ? " db-lcore" : n.kind === "hub" ? " db-lhub" : "") });
      d.setText(n.t);
      this.labelEls.set(n.id, d);
    }
    /* island nameplates (radial mode) — click to enter the cluster */
    this.sectorLabelEls = this.groups.map((g, gi) => {
      const d = this.labelWrap.createDiv({ cls: "db-lbl db-lsect" });
      d.setText(g.replace(/^_brain \/ /, ""));
      d.onclick = () => { if (this.layoutMode === "radial") this.enterCluster(gi); };
      return d;
    });

    /* picking */
    const rc = this.rc = new T.Raycaster(); this.m2 = new T.Vector2();
    rc.params.Sprite = { threshold: 2 };
    let downAt = null;
    const cvs = renderer.domElement;
    const onDown = (e) => { downAt = { x: e.clientX, y: e.clientY }; };
    const onUp = (e) => {
      if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5){ downAt = null; return; }
      downAt = null;
      const n = this.castAt(e);
      if (!n){ this.clearSel(); return; }
      if (n.kind === "core"){ this.exitCluster(); return; }
      if (this.layoutMode === "radial" && n.kind === "hub" && this.focusedGroup !== n.g){ this.enterCluster(n.g); return; }
      this.select(n);
    };
    let hoverTick = 0;
    const onMove = (e) => {
      if (++hoverTick % 3) return;
      const n = this.castAt(e);
      if (n !== this.hover){ this.hover = (n && n.kind !== "core") ? n : null; cvs.style.cursor = n ? "pointer" : "grab"; }
    };
    cvs.addEventListener("pointerdown", onDown);
    cvs.addEventListener("pointerup", onUp);
    cvs.addEventListener("pointermove", onMove);

    /* zoom label */
    this._lastZ = "";
    const onCtl = () => {
      if (this.focusedGroup != null) return;   /* breadcrumb shows the cluster name while inside */
      const d = controls.getDistance();
      const s = d < 90 ? "synapse" : d < 180 ? "system" : d > 500 ? "deep space" : "organism";
      if (s !== this._lastZ){ this.zEl.setText(s); this._lastZ = s; }
    };
    controls.addEventListener("change", onCtl);

    /* resize */
    const ro = new ResizeObserver(() => {
      const w = Math.max(1, stage.clientWidth), h = Math.max(1, stage.clientHeight);
      this.W = w; this.H = h;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setSize(w, h); composer.setSize(w, h);
    });
    ro.observe(stage);

    this._disposers.push(() => {
      ro.disconnect();
      cvs.removeEventListener("pointerdown", onDown);
      cvs.removeEventListener("pointerup", onUp);
      cvs.removeEventListener("pointermove", onMove);
      controls.removeEventListener("change", onCtl);
      this.teardownScene();
    });
  }

  teardownScene(){
    if (!this.renderer) return;
    this.killParticles();
    this.controls.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mat = o.material;
      if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((m) => m.dispose && m.dispose());
    });
    if (this.GLOW) this.GLOW.dispose();
    if (this.STAR) this.STAR.dispose();
    if (this.bloom && this.bloom.dispose) this.bloom.dispose();
    if (this.composer && this.composer.dispose) this.composer.dispose();
    this.renderer.dispose();
    if (this.renderer.forceContextLoss) this.renderer.forceContextLoss();
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
    this.renderer = null;
    this.orbitRings = null; this.islandRings = null;
  }

  castAt(ev){
    const r = this.renderer.domElement.getBoundingClientRect();
    this.m2.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    this.m2.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    this.rc.setFromCamera(this.m2, this.camera);
    const objs = [this.orbMesh], map = [null];
    for (let i = 0; i < this.pickables.length; i++){
      if (this.visible(this.pickMap[i])){ objs.push(this.pickables[i]); map.push(this.pickMap[i]); }
    }
    const hit = this.rc.intersectObjects(objs, true);
    for (const h of hit){
      if (h.object === this.orbMesh){
        const n = this.ORBS[h.instanceId];
        if (n && this.visible(n)) return n;
        continue;
      }
      let o = h.object;
      while (o){
        const i = objs.indexOf(o);
        if (i > 0) return map[i];
        for (let k = 1; k < map.length; k++) if (map[k].mesh === o) return map[k];
        o = o.parent;
      }
    }
    return null;
  }

  bez(a, b){
    this.tmpV.set(b.x - a.x, b.y - a.y, b.z - a.z);
    const len = this.tmpV.length() || 1; this.tmpV.normalize();
    this.perV.crossVectors(this.tmpV, this.up);
    if (this.perV.lengthSq() < .01) this.perV.set(1, 0, 0);
    this.perV.normalize().multiplyScalar(len * .14);
    this.bz.cx = (a.x + b.x) / 2 + this.perV.x;
    this.bz.cy = (a.y + b.y) / 2 + this.perV.y;
    this.bz.cz = (a.z + b.z) / 2 + this.perV.z;
  }

  spawnParticles(node){
    this.killParticles();
    const mine = this.ALL_LINKS.filter((l) => l.s === node || l.t === node).slice(0, 60);
    const col = node.kind === "core" ? "#E0A94E" : gcol(node.g);
    mine.forEach((l, li) => {
      for (let k = 0; k < 2; k++){
        const sp = new T.Sprite(new T.SpriteMaterial({ map: this.GLOW, color: new T.Color(col), transparent: true,
          opacity: 1, blending: T.AdditiveBlending, depthWrite: false }));
        sp.scale.setScalar(2.4); this.scene.add(sp);
        this.particles.push({ link: l, t: -(k * .5) - li * .05, sp });
      }
    });
  }
  killParticles(){
    if (!this.particles) return;
    this.particles.forEach((p) => { this.scene.remove(p.sp); p.sp.material.dispose(); });
    this.particles = [];
  }

  activeSet(){
    const n = this.hover || this.selected;
    if (!n) return null;
    const set = new Set([n.id, "__core"]);
    if (n.id !== "__core"){ for (const m of this.adj.get(n.id) || []) set.add(m); }
    else this.coreLinks.forEach((l) => set.add(l.t.id));
    return set;
  }

  flyTo(n){
    this.controls.autoRotate = false;
    const dist = Math.max(46, this.radius(n) * 11);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.flyTarget = { tx: n.x, ty: n.y, tz: n.z,
      cx: n.x + dir.x * dist, cy: n.y + dir.y * dist, cz: n.z + dir.z * dist };
  }
  goHome(){
    this.focusedGroup = null;
    this.controls.autoRotate = true;
    this.flyTarget = this.layoutMode === "radial"
      ? { tx: 0, ty: 0, tz: 0, cx: 0, cy: this.layoutExtent * 1.1 + 130, cz: this.layoutExtent * 1.15 + 150 }
      : { tx: 0, ty: 0, tz: 0, cx: 0, cy: 40, cz: 260 };
  }

  startLoop(){
    const step = () => {
      this._raf = requestAnimationFrame(step);
      if (!this.renderer || !this.containerEl.isShown()) return;
      this.frame();
    };
    step();
  }

  frame(){
    const t = this.clock.getElapsedTime();
    if (this.layoutMode === "radial"){
      for (const n of this.ALL){
        if (n.tx === undefined) continue;
        n.x += (n.tx - n.x) * .08; n.y += (n.ty - n.y) * .08; n.z += (n.tz - n.z) * .08;
      }
    } else {
      this.tick();
    }
    if (this.flyTarget){
      const f = this.flyTarget, c = this.controls, cam = this.camera;
      c.target.x += (f.tx - c.target.x) * .1; c.target.y += (f.ty - c.target.y) * .1; c.target.z += (f.tz - c.target.z) * .1;
      cam.position.x += (f.cx - cam.position.x) * .1;
      cam.position.y += (f.cy - cam.position.y) * .1;
      cam.position.z += (f.cz - cam.position.z) * .1;
      if (Math.abs(cam.position.x - f.cx) < .5 && Math.abs(cam.position.y - f.cy) < .5) this.flyTarget = null;
    }
    this.controls.update();
    this.timeMats.forEach((m) => { if (m.uniforms && m.uniforms.uTime) m.uniforms.uTime.value = t; });

    const act = this.activeSet();
    const focusN = this.hover || this.selected;
    for (const n of this.ALL){
      const m = n.mesh; if (!m) continue;
      const vis = this.visible(n);
      m.visible = vis;
      if (!vis) continue;
      const on = (!act || act.has(n.id)) && (this.focusedGroup == null || n.g === this.focusedGroup || n.kind === "core");
      if (n.kind === "core"){
        m.position.set(n.x, n.y, n.z); m.rotation.y += .002;
      } else if (n.kind === "hub"){
        m.position.set(n.x, n.y, n.z);
        if (n.body) n.body.rotation.y += .004;
        const sc = on ? 1 : .82;
        m.scale.x += (sc - m.scale.x) * .1; m.scale.y = m.scale.z = m.scale.x;
        if (n.pmat) n.pmat.uniforms.uAct.value += (((n === focusN) ? 1 : 0) - n.pmat.uniforms.uAct.value) * .1;
        if (n.atmo) n.atmo.material.opacity += ((on ? .24 : .07) - n.atmo.material.opacity) * .1;
        if (n.ringM) n.ringM.rotation.z += .0022;
      } else if (n.kind === "star"){
        m.position.set(n.x, n.y, n.z);
        const tw = .8 + .35 * Math.sin(t * 4 + (n.tw || 0));
        m.scale.setScalar(this.radius(n) * 2.4 * tw * (on ? 1 : .6));
        m.material.opacity += ((on ? .55 : .12) - m.material.opacity) * .12;
      }
    }
    /* instanced note-spheres */
    for (let i = 0; i < this.ORBS.length; i++){
      const n = this.ORBS[i];
      const nvis = this.visible(n);
      const on = (!act || act.has(n.id)) && (this.focusedGroup == null || n.g === this.focusedGroup);
      const focus = n === focusN;
      this.dummy.position.set(n.x, n.y, n.z);
      this.dummy.scale.setScalar(nvis ? this.radius(n) * (focus ? 1.45 : 1) : .0001);
      this.dummy.updateMatrix();
      this.orbMesh.setMatrixAt(i, this.dummy.matrix);
      this.cTmp.set(gcol(n.g));
      if (act && !on) this.cTmp.multiplyScalar(.14);
      else if (focus) this.cTmp.multiplyScalar(1.8);
      this.orbMesh.setColorAt(i, this.cTmp);
      if (n.halo){
        n.halo.visible = nvis;
        n.halo.position.set(n.x, n.y, n.z);
        n.halo.material.opacity += (((nvis && on) ? .22 : .04) - n.halo.material.opacity) * .12;
      }
    }
    this.orbMesh.instanceMatrix.needsUpdate = true;
    if (this.orbMesh.instanceColor) this.orbMesh.instanceColor.needsUpdate = true;
    /* selection / hover halo */
    if (focusN && focusN.kind !== "core"){
      this.selHalo.position.set(focusN.x, focusN.y, focusN.z);
      this.selHalo.scale.setScalar(this.radius(focusN) * (focusN.kind === "hub" ? 4.2 : 5.5));
      this.selHalo.material.color.set(gcol(focusN.g));
      this.selHalo.material.opacity += (.3 - this.selHalo.material.opacity) * .15;
    } else {
      this.selHalo.material.opacity += (0 - this.selHalo.material.opacity) * .15;
    }
    /* links */
    let vi = 0;
    const SEG = this.SEG, lPos = this.lPos, lCol = this.lCol;
    for (let li = 0; li < this.ALL_LINKS.length; li++){
      const l = this.ALL_LINKS[li], a = l.s, b = l.t;
      const lVis = this.visible(a) && this.visible(b);
      const on = !act || (act.has(a.id) && act.has(b.id));
      const isHot = act && on && focusN && (a === focusN || b === focusN || a.kind === "core" || b.kind === "core");
      let col;
      if (!lVis) col = this.C_OFF;
      else if (isHot && focusN && (a === focusN || b === focusN)) col = (focusN.kind === "hub" || focusN.kind === "core") ? this.C_HOT : this.C_HOT2;
      else col = l.c;
      if (act && !on && lVis){ this.hotColor.copy(l.c).multiplyScalar(.15); col = this.hotColor; }
      if (this.focusedGroup != null && lVis && a.g !== this.focusedGroup && b.g !== this.focusedGroup){
        this.dimColor.copy(col).multiplyScalar(.1); col = this.dimColor;
      }
      this.bez(a, b);
      const bz = this.bz;
      for (let s = 0; s < SEG; s++){
        const u0 = s / SEG, u1 = (s + 1) / SEG;
        const p0 = vi * 3, p1 = (vi + 1) * 3;
        let iu = 1 - u0;
        lPos[p0] = iu * iu * a.x + 2 * iu * u0 * bz.cx + u0 * u0 * b.x;
        lPos[p0 + 1] = iu * iu * a.y + 2 * iu * u0 * bz.cy + u0 * u0 * b.y;
        lPos[p0 + 2] = iu * iu * a.z + 2 * iu * u0 * bz.cz + u0 * u0 * b.z;
        iu = 1 - u1;
        lPos[p1] = iu * iu * a.x + 2 * iu * u1 * bz.cx + u1 * u1 * b.x;
        lPos[p1 + 1] = iu * iu * a.y + 2 * iu * u1 * bz.cy + u1 * u1 * b.y;
        lPos[p1 + 2] = iu * iu * a.z + 2 * iu * u1 * bz.cz + u1 * u1 * b.z;
        lCol[p0] = lCol[p1] = col.r; lCol[p0 + 1] = lCol[p1 + 1] = col.g; lCol[p0 + 2] = lCol[p1 + 2] = col.b;
        vi += 2;
      }
    }
    this.lGeo.attributes.position.needsUpdate = true;
    this.lGeo.attributes.color.needsUpdate = true;
    /* particles */
    this.particles.forEach((p) => {
      p.t += .012; if (p.t > 1.05) p.t = -.05;
      if (p.t < 0){ p.sp.material.opacity = 0; return; }
      p.sp.material.opacity = 1;
      this.bez(p.link.s, p.link.t);
      const bz = this.bz, a = p.link.s, b = p.link.t, u = p.t, iu = 1 - u;
      p.sp.position.set(iu * iu * a.x + 2 * iu * u * bz.cx + u * u * b.x,
        iu * iu * a.y + 2 * iu * u * bz.cy + u * u * b.y,
        iu * iu * a.z + 2 * iu * u * bz.cz + u * u * b.z);
    });
    this.composer.render();
    /* labels: planets reveal on hover / focus context only */
    for (const n of this.ALL){
      const el = this.labelEls.get(n.id); if (!el) continue;
      if (!this.visible(n)){ el.style.opacity = "0"; continue; }
      this.wp.set(n.x, n.y, n.z); this.pv.copy(this.wp).project(this.camera);
      if (this.pv.z > 1 || this.pv.z < -1){ el.style.opacity = "0"; continue; }
      const sx = (this.pv.x * .5 + .5) * this.W, sy = (-this.pv.y * .5 + .5) * this.H;
      const on = (!act || act.has(n.id)) && (this.focusedGroup == null || n.g === this.focusedGroup || n.kind === "core");
      const dist = this.camera.position.distanceTo(this.wp);
      let op;
      if (n.kind === "core") op = 1;
      else if (n.kind === "hub") op = (this.showAllLabels || n === focusN) ? 1 : 0;
      else if (this.showAllLabels || n === focusN) op = on ? 1 : .3;
      else op = (dist < 130 ? .95 : dist < 220 ? .45 : 0) * (on ? 1 : .18);
      if (act && act.has(n.id) && n.kind !== "core") op = 1;
      if (this.focusedGroup != null) op = (n.g === this.focusedGroup) ? Math.max(op, .95) : (n.kind === "core" ? op : 0);
      el.style.transform = "translate(" + sx.toFixed(1) + "px," + sy.toFixed(1) + "px) translate(-50%,-150%)";
      el.style.opacity = String(op);
    }
    /* sector nameplates */
    if (this.sectorLabelEls){
      this.sectorLabelEls.forEach((el) => { el.style.opacity = "0"; });
      if (this.layoutMode === "radial"){
        for (const s of this.sectorInfo){
          const el = this.sectorLabelEls[s.g]; if (!el) continue;
          const dd = Math.hypot(s.cx, s.cz) || 1;
          this.wp.set(s.cx + s.cx / dd * (s.r + 16), 4, s.cz + s.cz / dd * (s.r + 16));
          this.pv.copy(this.wp).project(this.camera);
          if (this.pv.z > 1 || this.pv.z < -1) continue;
          el.style.transform = "translate(" + ((this.pv.x * .5 + .5) * this.W).toFixed(1) + "px," +
            ((-this.pv.y * .5 + .5) * this.H).toFixed(1) + "px) translate(-50%,-50%)";
          el.style.opacity = this.focusedGroup == null ? ".6" : (s.g === this.focusedGroup ? ".9" : ".08");
        }
      }
    }
  }
}
