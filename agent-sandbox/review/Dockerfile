# Code reviewer: opencode + a baked code-review skill. READ-ONLY by design —
# 2pizzas clones with a read-only token (REVIEW_TOKEN) and the container never
# receives the write token, so a review task cannot push or post; 2pizzas
# posts the review comment itself from the task log.
FROM agent-sandbox:opencode

COPY skills/ /root/.config/opencode/skill/

CMD ["sleep", "infinity"]
