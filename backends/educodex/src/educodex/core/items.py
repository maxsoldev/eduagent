"""Response items: the units of conversation history in the Responses API.

Mirrors codex-rs/protocol/src/models.rs (`ResponseItem`). We keep them as plain dicts in the
exact JSON wire shape, so what you see in history is what the model receives.

Item types used by educodex:
  message                {role: developer|user|assistant, content: [{type: input_text|output_text, text}]}
  reasoning              {summary: [...], encrypted_content}          (from the model, sent back as-is)
  function_call          {name, arguments (JSON string), call_id}     (model asks for a JSON tool)
  function_call_output   {call_id, output}                            (our answer)
  custom_tool_call       {name, input (free text), call_id}           (model asks for a freeform tool)
  custom_tool_call_output{call_id, output}
"""

from typing import Any

ResponseItem = dict[str, Any]

TOOL_CALL_TYPES = ("function_call", "custom_tool_call")


def message(role: str, *texts: str) -> ResponseItem:
    """One message; each text becomes a separate content part (Codex bundles fragments this way)."""
    part_type = "output_text" if role == "assistant" else "input_text"
    return {"type": "message", "role": role, "content": [{"type": part_type, "text": t} for t in texts]}


def user_message(text: str) -> ResponseItem:
    return message("user", text)


def developer_message(*texts: str) -> ResponseItem:
    return message("developer", *texts)


def tool_output(call: ResponseItem, output: str) -> ResponseItem:
    """The output item that answers a tool call. Its type must match the call's type."""
    output_type = "custom_tool_call_output" if call["type"] == "custom_tool_call" else "function_call_output"
    return {"type": output_type, "call_id": call["call_id"], "output": output}


def clean_output_item(item: ResponseItem) -> ResponseItem:
    """Drop API-only fields (status, annotations, logprobs) before recording, as Codex does by
    deserialising into its typed ResponseItem (protocol/src/models.rs)."""
    item = {k: v for k, v in item.items() if k != "status"}
    if item.get("type") == "message":
        item["content"] = [{k: v for k, v in part.items() if k not in ("annotations", "logprobs")}
                           for part in item.get("content", [])]
    return item


def message_text(item: ResponseItem) -> str:
    return "".join(part.get("text", "") for part in item.get("content", []))


def is_tool_call(item: ResponseItem) -> bool:
    return item.get("type") in TOOL_CALL_TYPES


def approx_tokens(item: ResponseItem) -> int:
    """Rough size of an item: ~4 bytes per token, like Codex's approx_token_count."""
    import json

    return (len(json.dumps(item, ensure_ascii=False).encode()) + 3) // 4
