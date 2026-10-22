"""Agent-owned MAF stdio adapter. Only the explicit offline replay backend is enabled.

The host reviews one exact artifact action. Framework approval requests must match it.
Python audit guards are defense in depth, not a substitute for host OS isolation.
"""
import asyncio
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sys


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def receive():
    line = sys.stdin.buffer.readline(262145)
    if not line or len(line) > 262144 or not line.endswith(b"\n"):
        raise ValueError("Missing or oversized host message")
    return json.loads(line)


def real_path(value):
    p = Path(value)
    if not p.is_absolute():
        raise ValueError("Absolute owned path required")
    for item in (p, *p.parents):
        if item.is_symlink() or (hasattr(item, "is_junction") and item.is_junction()):
            raise ValueError("Linked owned path denied")
    return p


def save_new(file, value):
    data = (canonical(value) + "\n").encode("utf-8")
    with file.open("xb") as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    return hashlib.sha256(data).hexdigest()


async def main():
    if len(sys.argv) != 3 or sys.argv[1] != "--site-packages" or not sys.flags.isolated or not sys.flags.no_site:
        raise ValueError("Use the fixed Agent launch contract")
    site = real_path(sys.argv[2])
    # No site processing, .pth execution, user modules, startup configuration or environment imports.
    sys.path.append(str(site))
    if importlib.metadata.version("agent-framework-core") != "1.23.0":
        raise ValueError("Unqualified MAF version")
    from agent_framework import (BaseChatClient, ChatMiddlewareLayer, ChatResponse, Content,
                                 FunctionInvocationLayer, Message, create_harness_agent, tool)

    start = receive()
    binding = {k: start[k] for k in ("schema", "taskId", "preparedHash", "scopeHash", "sessionId")}
    if binding["schema"] != "datapass.maf-wire/1" or start["type"] != "start" or binding["sessionId"] != "maf:" + binding["preparedHash"]:
        raise ValueError("Invalid task binding")
    if not all(re.fullmatch(r"[a-f0-9]{64}", binding[k]) for k in ("preparedHash", "scopeHash")):
        raise ValueError("Invalid task hashes")
    action = start["action"]
    if set(action) != {"tool", "filename", "content"} or action["tool"] != "write_artifact" or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.txt", action["filename"]):
        raise ValueError("Invalid exact tool action")
    content = action["content"].encode("utf-8")
    if not 0 < len(content) <= 16384 or b"\0" in content:
        raise ValueError("Invalid artifact content")
    cwd, state = real_path(start["cwd"]), real_path(start["stateDirectory"])
    if Path.cwd().resolve() != cwd.resolve():
        raise ValueError("Wrong owned working directory")
    artifact = real_path(str(cwd / action["filename"]))
    approval = json.loads((state / "host-approval.json").read_bytes())
    if any(approval[k] != binding[k] for k in ("taskId", "preparedHash", "scopeHash")) or approval["actionHash"] != digest(action):
        raise ValueError("Host approval does not bind this task/action")
    writable = {str(artifact.resolve()), *(str((state / n).resolve()) for n in ("pending-session.json", "effect-intent.json", "effect-result.json", "session.json"))}

    def guard(event, args):
        if event in {"socket.connect", "socket.bind", "socket.getaddrinfo", "subprocess.Popen", "os.system", "os.exec", "os.posix_spawn"}:
            raise RuntimeError("Offline MAF adapter forbids network and child processes")
        if event == "open" and isinstance(args[0], (str, bytes, os.PathLike)):
            mode, flags = args[1], args[2]
            if (mode and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)):
                target = real_path(os.fsdecode(args[0]))
                if str(target.resolve()) not in writable:
                    raise RuntimeError("Write outside the exact approved artifact/state denied")
    sys.addaudithook(guard)

    def emit(kind, **value):
        print(canonical({**binding, "type": kind, **value}), flush=True)

    authorized = False
    effects = 0

    @tool(approval_mode="always_require")
    def write_artifact(filename: str, content: str) -> str:
        """Create the one exact host-reviewed artifact, once, without overwriting."""
        nonlocal effects
        if not authorized or {"tool": "write_artifact", "filename": filename, "content": content} != action or effects:
            raise ValueError("Tool action differs from exact host approval")
        save_new(state / "effect-intent.json", {**binding, "actionHash": digest(action)})
        target = real_path(str(artifact))
        data = content.encode("utf-8")
        with target.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        effects += 1
        result = {"filename": filename, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
        save_new(state / "effect-result.json", {**binding, "artifact": result})
        return canonical(result)

    class Replay(FunctionInvocationLayer, ChatMiddlewareLayer, BaseChatClient):
        calls = 0

        async def _inner_get_response(self, *, messages, stream, options, **kwargs):
            self.calls += 1
            if stream or self.calls > 2:
                raise ValueError("Unexpected model surface or repeated invocation")
            results = [c for m in messages for c in m.contents if c.type == "function_result"]
            if results:
                if effects != 1:
                    raise ValueError("Tool failed without a completed artifact")
                return ChatResponse(messages=[Message("assistant", ["Exact artifact action completed"])])
            if self.calls != 1:
                raise ValueError("Repeated action proposal denied")
            return ChatResponse(messages=[Message("assistant", [Content.from_function_call(
                "action:" + binding["preparedHash"], "write_artifact",
                arguments={"filename": action["filename"], "content": action["content"]})])], finish_reason="tool_calls")

    agent = create_harness_agent(client=Replay(), name="datapass-maf-offline",
        tools=[write_artifact], harness_instructions="Perform only the exact host-reviewed artifact action.",
        disable_todo=True, disable_mode=True, disable_file_memory=True, disable_web_search=True,
        disable_tool_auto_approval=True, disable_compaction=True)
    session = agent.create_session()
    emit("started")
    proposal = await agent.run("Perform the exact approved artifact plan", session=session)
    pending = [c for m in proposal.messages for c in m.contents if c.type == "function_approval_request"]
    if len(pending) != 1 or effects:
        raise ValueError("Expected one approval request and zero effects")
    request = pending[0]
    call = request.function_call
    arguments = json.loads(call.arguments) if isinstance(call.arguments, str) else call.arguments
    if call.name != "write_artifact" or arguments != {"filename": action["filename"], "content": action["content"]}:
        raise ValueError("Framework requested an unreviewed action")
    save_new(state / "pending-session.json", {**binding, "session": session.to_dict(), "approval": request.to_dict()})
    emit("approval", approvalId=request.id, actionHash=digest(action))
    response = receive()
    if any(response.get(k) != v for k, v in binding.items()) or response.get("type") != "approval-response" or response.get("approved") is not True or response.get("approvalId") != request.id or response.get("actionHash") != digest(action):
        raise ValueError("Foreign, denied or stale tool approval")
    durable = json.loads((state / "tool-approval.json").read_bytes())
    if any(durable.get(k) != response.get(k) for k in (*binding, "approvalId", "actionHash", "approved")):
        raise ValueError("Tool approval is not durably recorded")
    authorized = True
    await agent.run(Message("user", [Content.from_function_approval_response(
        approved=True, id=request.id, function_call=request.function_call)]), session=session)
    if effects != 1:
        raise ValueError("No completed tool effect")
    session_hash = save_new(state / "session.json", {**binding, "session": session.to_dict()})
    emit("completed", actionHash=digest(action), sessionSha256=session_hash,
         artifact={"filename": action["filename"], "sha256": hashlib.sha256(artifact.read_bytes()).hexdigest(), "bytes": len(content)})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        # No paths, task text, model content, environment or credentials in diagnostics.
        print("MAF adapter did not produce a qualified terminal result", file=sys.stderr)
        sys.exit(1)
