export interface AutoResumeDecision {
  resume: boolean;
  reason: string;
}

export function shouldAutoResume(input: {
  parentRun?: { path?: string; head_branch?: string; conclusion?: string; display_title?: string };
  jobs?: Array<{ name?: string; conclusion?: string; steps?: Array<{ name?: string; conclusion?: string }> }>;
  failedLogs?: string;
  priorResumeCount?: number;
}): AutoResumeDecision;
