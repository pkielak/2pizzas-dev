# Code reviewer: opencode + a baked code-review skill. READ-ONLY by design —
# 00-tea clones with a read-only token (REVIEW_TOKEN) and the container never
# receives the write token, so a review task cannot push or post; 00-tea
# posts the review comment itself from the task log.
FROM agent-sandbox:opencode

COPY skills/ /root/.config/opencode/skill/

CMD ["sleep", "infinity"]
