function sameSize(a, b) {
  return a !== null && a.cols === b.cols && a.rows === b.rows;
}

function sizesDiverge(a, b) {
  return a.cols !== b.cols || a.rows !== b.rows;
}

export class V2ResizeBroker {
  constructor(policy, applySize) {
    this.policy = policy;
    this.applySize = applySize;
    this.viewers = new Map();
    this.negotiated = null;
    this.applyCalls = [];
    this.recency = [];
  }

  attach(id, size) {
    this.viewers.set(id, { id, size, focused: false, visible: true });
    this.touch(id);
    if (this.visibleViewers().length === 1) {
      this.setFocusedId(id);
      return this.commit(size, 'applied-sole');
    }
    return this.evaluate(id);
  }

  detach(id) {
    const wasFocused = this.viewers.get(id)?.focused === true;
    this.viewers.delete(id);
    this.recency = this.recency.filter((x) => x !== id);
    if (this.viewers.size === 0) {
      return { applied: false, reason: 'held-all-hidden', size: this.negotiated };
    }
    if (this.policy === 'follow-focused' && wasFocused) {
      const next = this.mostRecentVisible();
      if (next) {
        this.setFocusedId(next.id);
        return this.commit(next.size, 'applied-focused');
      }
      return { applied: false, reason: 'held-all-hidden', size: this.negotiated };
    }
    return this.evaluateRemaining();
  }

  setFocus(id) {
    const viewer = this.viewers.get(id);
    if (!viewer) {
      return { applied: false, reason: 'ignored-unknown', size: this.negotiated };
    }
    this.setFocusedId(id);
    this.touch(id);
    if (this.policy === 'follow-focused') {
      if (!viewer.visible) {
        return { applied: false, reason: 'ignored-hidden', size: this.negotiated };
      }
      return this.commit(viewer.size, 'applied-focused');
    }
    return this.evaluate(id);
  }

  setVisible(id, visible) {
    const viewer = this.viewers.get(id);
    if (!viewer) {
      return { applied: false, reason: 'ignored-unknown', size: this.negotiated };
    }
    viewer.visible = visible;
    if (!visible && viewer.focused) {
      viewer.focused = false;
      if (this.policy === 'follow-focused') {
        const next = this.mostRecentVisible();
        if (next) {
          this.setFocusedId(next.id);
          return this.commit(next.size, 'applied-focused');
        }
        return { applied: false, reason: 'held-all-hidden', size: this.negotiated };
      }
    }
    return this.evaluate(id);
  }

  requestResize(id, size) {
    const viewer = this.viewers.get(id);
    if (!viewer) {
      return { applied: false, reason: 'ignored-unknown', size: this.negotiated };
    }
    viewer.size = size;
    return this.evaluate(id);
  }

  evaluate(id) {
    const viewer = this.viewers.get(id);
    if (!viewer) {
      return { applied: false, reason: 'ignored-unknown', size: this.negotiated };
    }
    if (this.policy === 'per-viewer-reflow') {
      return this.evaluateReflow(viewer);
    }
    if (!viewer.visible) {
      return { applied: false, reason: 'ignored-hidden', size: this.negotiated };
    }
    if (this.policy === 'follow-focused') {
      if (!viewer.focused) {
        return { applied: false, reason: 'ignored-unfocused', size: this.negotiated };
      }
      return this.commit(viewer.size, 'applied-focused');
    }
    return this.commit(viewer.size, 'applied-visible');
  }

  evaluateRemaining() {
    if (this.policy === 'per-viewer-reflow') {
      const visible = this.visibleViewers();
      if (visible.length === 0) {
        return { applied: false, reason: 'held-all-hidden', size: this.negotiated };
      }
      const first = visible[0];
      if (visible.some((v) => sizesDiverge(v.size, first.size))) {
        return { applied: false, reason: 'unsupported-divergent', size: this.negotiated };
      }
      return this.commit(first.size, 'applied-visible');
    }
    return { applied: false, reason: 'held-unchanged', size: this.negotiated };
  }

  evaluateReflow(viewer) {
    const visible = this.visibleViewers();
    if (visible.length === 0) {
      return { applied: false, reason: 'held-all-hidden', size: this.negotiated };
    }
    const first = visible[0];
    if (visible.some((v) => sizesDiverge(v.size, first.size))) {
      return { applied: false, reason: 'unsupported-divergent', size: this.negotiated };
    }
    if (!viewer.visible) {
      return { applied: false, reason: 'ignored-hidden', size: this.negotiated };
    }
    return this.commit(viewer.size, 'applied-visible');
  }

  commit(size, reason) {
    if (sameSize(this.negotiated, size)) {
      return { applied: false, reason: 'held-unchanged', size };
    }
    this.applySize(size.cols, size.rows);
    this.applyCalls.push({ ...size });
    this.negotiated = { ...size };
    return { applied: true, reason, size: this.negotiated };
  }

  visibleViewers() {
    return [...this.viewers.values()].filter((v) => v.visible);
  }

  mostRecentVisible() {
    for (const id of this.recency) {
      const viewer = this.viewers.get(id);
      if (viewer?.visible) return viewer;
    }
    return undefined;
  }

  setFocusedId(id) {
    for (const viewer of this.viewers.values()) {
      viewer.focused = viewer.id === id;
    }
  }

  touch(id) {
    this.recency = [id, ...this.recency.filter((x) => x !== id)];
  }
}
