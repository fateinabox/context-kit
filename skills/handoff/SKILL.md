---
name: handoff
description: Generate a coherent summary of the current chat session including references and citations to prepare for handoff to another agent.
disable-model-invocation: true
hint: What will the next session be used for?
---

Write a handoff document summarizing the conversation for handoff to another agent so they may continue the work.

Do no duplicate content already captured in the handoff document. Use references and lists to highlight key points.

Do not include any sensitive or confidential information in the document such as raw api keys, tokens, or other credentials.

If the user passed arguments, treat them as a description of the target of the next session and formulate the summary accordingly.

Write this handoff document to an accessible location so the next agent can review it.

Maintain a clear and definitive "target"

## Patterns
- Include a "suggested skills" section in the handoff document highlighting the skills possibly needed for the next session.
- Include a "target" section in the handoff document describing the target of the next session.
- Include an "arguments" section in the handoff document describing the arguments passed by the user.
- Include an "issues" section in the handoff document describing any issues or concerns raised by the user.
- Include a "summary" section in the handoff document summarizing the key points of the conversation.
