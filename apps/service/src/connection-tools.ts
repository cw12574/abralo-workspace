// These tools enforce account grants and durable write approvals in Abralo.
// Transport-level permission prompts must not create a second approval loop.
export const connectionTools = [
  'workspace_connection',
  'workspace_connection_status',
  'workspace_connection_tools',
  'workspace_connection_call',
  'workspace_connection_action',
] as const;
