// Minimal behavior-tree primitives, generic over whatever context object a
// caste's tree closes over (state/colonist/walkable/now, typically). No
// blackboard, no interrupts, no tick-scoped memory — every node re-evaluates
// from scratch each call, which is all these AIs need since the game state
// itself already holds whatever "memory" a node cares about (forageTarget,
// path, scoutState, ...).
export type NodeStatus = 'success' | 'failure' | 'running';
export type BTNode<Ctx> = (ctx: Ctx) => NodeStatus;

// runs children in order, stopping at the first non-success (mirrors an AND)
export function sequence<Ctx>(...children: BTNode<Ctx>[]): BTNode<Ctx> {
  return (ctx) => {
    for (const child of children) {
      const status = child(ctx);
      if (status !== 'success') return status;
    }
    return 'success';
  };
}

// runs children in order, stopping at the first non-failure (mirrors an OR)
export function selector<Ctx>(...children: BTNode<Ctx>[]): BTNode<Ctx> {
  return (ctx) => {
    for (const child of children) {
      const status = child(ctx);
      if (status !== 'failure') return status;
    }
    return 'failure';
  };
}

// a leaf that only ever tests the context, never mutates it
export function condition<Ctx>(test: (ctx: Ctx) => boolean): BTNode<Ctx> {
  return (ctx) => (test(ctx) ? 'success' : 'failure');
}

// a leaf that does something; returning false means "didn't pan out" (so a
// parent selector should try the next option), anything else means success
export function action<Ctx>(run: (ctx: Ctx) => boolean | void): BTNode<Ctx> {
  return (ctx) => (run(ctx) === false ? 'failure' : 'success');
}
