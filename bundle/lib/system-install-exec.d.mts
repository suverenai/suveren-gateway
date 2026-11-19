import type { PlanStep } from './system-install-mac.mjs';
export declare function isAllowedCommand(argv: string[]): boolean;
export declare function validatePlan(steps: PlanStep[], opts?: { prefix?: string }): void;
export declare function executePlan(
  plan: { steps: PlanStep[] },
  opts?: {
    prefix?: string;
    runner?: (argv: string[]) => { status: number | null; stderr?: string };
    chown?: (path: string, owner: string, recursive?: boolean) => { status: number | null } | void;
  },
): Array<{ recorded?: string; ran?: string; did?: string }>;
