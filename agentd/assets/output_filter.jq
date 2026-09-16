select(.type != null) |
if .type == "message_update" then
  if .assistantMessageEvent.type == "text_delta" then
    (.assistantMessageEvent.delta // empty)
  elif .assistantMessageEvent.type == "thinking_start" then
    "\n  \u2514 thinking\n"
  elif .assistantMessageEvent.type == "toolcall_start"
       and (.assistantMessageEvent.toolName | type) == "string" then
    "\n  \u2514 \(.assistantMessageEvent.toolName)\n"
  else
    empty
  end
elif .type == "tool_execution_start" then
  "\n  \u25b8 \(.toolName) \(if .args.command then (.args.command | if length > 60 then .[0:60] + "…" else . end) else "" end)\n"
elif .type == "tool_execution_end" and .isError == true then
  "\n  \u2717 \(.toolName // "tool") failed\n"
else
  empty
end
