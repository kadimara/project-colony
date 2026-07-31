// Generic behavior-tree primitives: Sequence/Selector composites plus
// Condition/Action leaves, all typed over a caller-supplied context. Nodes
// are plain functions (Ctx) => NodeStatus rather than a class hierarchy, so
// a tree is just data built by composing these calls. `running` exists for a
// standard node-status surface, but nothing in this codebase's trees needs
// it yet — every current action fully resolves within the tick it runs in.
export type NodeStatus = 'success' | 'failure' | 'running';

export type BTNode<Ctx> = (ctx: Ctx) => NodeStatus;

// runs children in order, stopping at the first that doesn't succeed
export function sequence<Ctx>(...children: BTNode<Ctx>[]): BTNode<Ctx> {
  return (ctx) => {
    for (const child of children) {
      const status = child(ctx);
      if (status !== 'success') return status;
    }
    return 'success';
  };
}

// runs children in order, stopping at the first that doesn't fail
export function selector<Ctx>(...children: BTNode<Ctx>[]): BTNode<Ctx> {
  return (ctx) => {
    for (const child of children) {
      const status = child(ctx);
      if (status !== 'failure') return status;
    }
    return 'failure';
  };
}

export function condition<Ctx>(pred: (ctx: Ctx) => boolean): BTNode<Ctx> {
  return (ctx) => (pred(ctx) ? 'success' : 'failure');
}

// wraps a body that performs work and optionally reports its own status;
// a body that returns nothing counts as a success
export function action<Ctx>(fn: (ctx: Ctx) => NodeStatus | void): BTNode<Ctx> {
  return (ctx) => fn(ctx) ?? 'success';
}
