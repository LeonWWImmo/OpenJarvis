"""Route handlers for the OpenAI-compatible API server."""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool

from openjarvis.core.types import Message, Role
from openjarvis.server.models import (
    ChatCompletionChunk,
    ChatCompletionRequest,
    ChatCompletionResponse,
    Choice,
    ChoiceMessage,
    ComplexityInfo,
    DeltaMessage,
    ModelListResponse,
    ModelObject,
    StreamChoice,
    UsageInfo,
)

router = APIRouter()


def _to_messages(chat_messages) -> list[Message]:
    """Convert Pydantic ChatMessage objects to core Message objects."""
    messages = []
    for m in chat_messages:
        role = Role(m.role) if m.role in {r.value for r in Role} else Role.USER
        messages.append(
            Message(
                role=role,
                content=m.content or "",
                name=m.name,
                tool_call_id=m.tool_call_id,
            )
        )
    return messages


def _is_synthetic_error_message(message) -> bool:
    """Drop UI transport errors before they become model prompt context."""
    if getattr(message, "role", "") != "assistant":
        return False
    text = (getattr(message, "content", "") or "").strip()
    return (
        text.startswith("Error: HTTP ")
        or text.startswith("Error: Connection failed")
        or text.startswith("Error: Chat request failed")
        or text.startswith("No response was generated")
    )


def _sanitize_chat_messages(request_body: ChatCompletionRequest) -> None:
    messages = [
        msg for msg in request_body.messages if not _is_synthetic_error_message(msg)
    ]
    # Local desktop mode should not replay long stale conversations into small
    # Ollama models. The active user turn remains last, so keep the recent tail.
    request_body.messages = messages[-8:]
    if request_body.model.startswith(("qwen3:0.6b", "qwen3.5:0.8b")):
        request_body.max_tokens = min(request_body.max_tokens, 1024)


def _get_jarvis_system_prompt(config: Any | None = None) -> str:
    """Return the local desktop Jarvis persona prompt."""
    configured = ""
    if config is not None:
        agent_cfg = getattr(config, "agent", None)
        configured = (getattr(agent_cfg, "system_prompt", "") or "").strip()
        prompt_path = (getattr(agent_cfg, "system_prompt_path", "") or "").strip()
        if not configured and prompt_path:
            try:
                from pathlib import Path

                configured = Path(prompt_path).expanduser().read_text(encoding="utf-8").strip()
            except Exception:
                configured = ""

    if configured:
        import datetime as _dt
        _now = _dt.datetime.now().astimezone()
        return configured + (
            "\n\nIMPORTANT - the real current date and time is "
            + _now.strftime("%A, %d %B %Y, %H:%M")
            + " (" + _now.strftime("%Z") + "). This is authoritative: always use THIS for any date, day, or time question, and ignore any different date or time that may appear earlier in the conversation."
        )

    return (
        "You are Jarvis, a concise local assistant. "
        "Answer directly, stay technically precise, and say when context is uncertain. "
        "Use provided memory context only when it is relevant. "
        "Do not store new facts unless the caller explicitly requests it."
    )


def _ensure_system_prompt(request_body: ChatCompletionRequest, config: Any | None = None) -> None:
    """Prepend the Jarvis system prompt unless the caller already supplied one."""
    if any(msg.role == "system" for msg in request_body.messages):
        return

    from openjarvis.server.models import ChatMessage

    request_body.messages = [
        ChatMessage(role="system", content=_get_jarvis_system_prompt(config)),
        *request_body.messages,
    ]


@router.post("/v1/chat/completions")
async def chat_completions(request_body: ChatCompletionRequest, request: Request):
    """Handle chat completion requests (streaming and non-streaming)."""
    _sanitize_chat_messages(request_body)

    engine = request.app.state.engine
    agent = getattr(request.app.state, "agent", None)
    model = request_body.model

    # Inject memory context into messages before dispatching
    config = getattr(request.app.state, "config", None)
    _ensure_system_prompt(request_body, config)
    memory_backend = getattr(request.app.state, "memory_backend", None)
    if (
        config is not None
        and memory_backend is not None
        and config.agent.context_from_memory
        and request_body.messages
    ):
        try:
            from openjarvis.tools.storage.context import ContextConfig, inject_context

            # Extract query from the last user message
            query_text = ""
            for m in reversed(request_body.messages):
                if m.role == "user" and m.content:
                    query_text = m.content
                    break

            if query_text:
                messages = _to_messages(request_body.messages)
                ctx_cfg = ContextConfig(
                    top_k=config.memory.context_top_k,
                    min_score=config.memory.context_min_score,
                    max_context_tokens=config.memory.context_max_tokens,
                )
                enriched = inject_context(
                    query_text,
                    messages,
                    memory_backend,
                    config=ctx_cfg,
                )
                # Rebuild request messages from enriched Message objects
                if len(enriched) > len(messages):
                    from openjarvis.server.models import ChatMessage

                    new_msgs = []
                    for msg in enriched:
                        new_msgs.append(
                            ChatMessage(
                                role=msg.role.value,
                                content=msg.content,
                                name=msg.name,
                                tool_call_id=getattr(msg, "tool_call_id", None),
                            )
                        )
                    request_body.messages = new_msgs
        except Exception:
            logging.getLogger("openjarvis.server").debug(
                "Memory context injection failed",
                exc_info=True,
            )

    # Run complexity analysis on the last user message
    complexity_info = None
    query_text_for_complexity = ""
    for m in reversed(request_body.messages):
        if m.role == "user" and m.content:
            query_text_for_complexity = m.content
            break
    if query_text_for_complexity:
        try:
            from openjarvis.learning.routing.complexity import (
                adjust_tokens_for_model,
                score_complexity,
            )

            cr = score_complexity(query_text_for_complexity)
            suggested = adjust_tokens_for_model(
                cr.suggested_max_tokens,
                model,
            )
            complexity_info = ComplexityInfo(
                score=cr.score,
                tier=cr.tier,
                suggested_max_tokens=suggested,
            )
            # Bump max_tokens when complexity suggests more than what
            # the client requested — never reduce below the request value.
            if suggested > request_body.max_tokens:
                request_body.max_tokens = suggested
        except Exception:
            logging.getLogger("openjarvis.server").debug(
                "Complexity analysis failed",
                exc_info=True,
            )

    if request_body.stream:
        bus = getattr(request.app.state, "bus", None)
        # Use the agent stream bridge only when tools are present (the
        # bridge runs agent.run() synchronously and word-splits the result,
        # so it can't stream tokens in real-time).  For plain chat, stream
        # directly from the engine for true token-by-token output.
        if agent is not None and bus is not None and request_body.tools:
            return await _handle_agent_stream(agent, bus, model, request_body)
        return await _handle_stream(engine, model, request_body, complexity_info)

    # Non-streaming: use agent if available, otherwise direct engine call
    if agent is not None:
        return await run_in_threadpool(
            _handle_agent,
            agent,
            model,
            request_body,
            complexity_info,
        )

    bus = getattr(request.app.state, "bus", None)
    tool_executor = getattr(request.app.state, "tool_executor", None)
    return await run_in_threadpool(
        _handle_direct,
        engine,
        model,
        request_body,
        bus,
        complexity_info,
        tool_executor,
    )


def _generate_once(
    engine, messages, model, temperature, max_tokens, tools=None, bus=None
):
    """Single generate call, optionally with tools and instrumentation."""
    kwargs = {}
    if tools:
        kwargs["tools"] = tools
    if bus:
        from openjarvis.telemetry.wrapper import instrumented_generate
        return instrumented_generate(
            engine, messages, model=model, bus=bus,
            temperature=temperature, max_tokens=max_tokens, **kwargs,
        )
    return engine.generate(
        messages, model=model, temperature=temperature, max_tokens=max_tokens, **kwargs,
    )


def _build_response(
    content, model, usage, complexity_info=None, finish_reason="stop",
) -> ChatCompletionResponse:
    return ChatCompletionResponse(
        model=model,
        choices=[Choice(
            message=ChoiceMessage(role="assistant", content=content),
            finish_reason=finish_reason,
        )],
        usage=UsageInfo(
            prompt_tokens=usage.get("prompt_tokens", 0),
            completion_tokens=usage.get("completion_tokens", 0),
            total_tokens=usage.get("total_tokens", 0),
        ),
        complexity=complexity_info,
    )


def _handle_direct(
    engine,
    model: str,
    req: ChatCompletionRequest,
    bus=None,
    complexity_info=None,
    tool_executor=None,
) -> ChatCompletionResponse:
    """Direct engine call — with tool execution loop when tool_executor is set."""
    messages = _to_messages(req.messages)
    openai_tools = None
    if tool_executor:
        openai_tools = tool_executor.get_openai_tools()
        # Inject tool descriptions into system prompt so the model knows it can call tools
        try:
            from openjarvis.tools._stubs import build_tool_descriptions
            tool_desc = build_tool_descriptions(list(tool_executor._tools.values()))
            sys_text = "\n\nDu hast Zugriff auf folgende Werkzeuge. Rufe sie bei Bedarf ueber function calling auf:\n" + tool_desc
            if messages and messages[0].role == Role.SYSTEM:
                messages[0] = Message(role=Role.SYSTEM, content=messages[0].content + sys_text)
            else:
                messages.insert(0, Message(role=Role.SYSTEM, content=sys_text))
        except Exception:
            import logging
            logging.getLogger("openjarvis.server").debug("Tool prompt injection failed", exc_info=True)

    total_usage = {}
    max_turns = 10

    for turn in range(max_turns):
        result = _generate_once(
            engine, messages, model, req.temperature, req.max_tokens,
            tools=openai_tools, bus=bus,
        )

        content = result.get("content", "")
        usage = result.get("usage", {})
        for k in ("prompt_tokens", "completion_tokens", "total_tokens"):
            total_usage[k] = total_usage.get(k, 0) + usage.get(k, 0)

        tool_calls = result.get("tool_calls")
        if not tool_calls:
            return _build_response(content, model, total_usage, complexity_info)

        # Append assistant message with tool calls
        from openjarvis.core.types import ToolCall

        messages.append(Message(role=Role.ASSISTANT, content=content, tool_calls=[
            ToolCall(id=tc["id"], name=tc["name"], arguments=tc["arguments"])
            for tc in tool_calls
        ]))

        # Execute each tool call
        for tc in tool_calls:
            tool_call = ToolCall(id=tc["id"], name=tc["name"], arguments=tc["arguments"])
            tool_result = tool_executor.execute(tool_call)
            messages.append(Message(
                role=Role.TOOL,
                content=tool_result.content,
                tool_call_id=tc["id"],
            ))

    return _build_response(
        "Maximum tool execution turns reached.",
        model, total_usage, complexity_info,
        finish_reason="length",
    )


def _handle_agent(
    agent,
    model: str,
    req: ChatCompletionRequest,
    complexity_info=None,
) -> ChatCompletionResponse:
    """Run through agent."""
    from openjarvis.agents._stubs import AgentContext

    # Build context from prior messages
    ctx = AgentContext()
    if len(req.messages) > 1:
        prior = _to_messages(req.messages[:-1])
        for m in prior:
            ctx.conversation.add(m)

    # Last message is the input
    input_text = req.messages[-1].content if req.messages else ""

    # Override agent model for this request if the caller specified one
    original_model = agent._model
    if model:
        agent._model = model
    try:
        result = agent.run(input_text, context=ctx)
    finally:
        agent._model = original_model

    usage = UsageInfo(
        prompt_tokens=result.metadata.get("prompt_tokens", 0),
        completion_tokens=result.metadata.get("completion_tokens", 0),
        total_tokens=result.metadata.get("total_tokens", 0),
    )

    # Include audio metadata if the agent produced audio (e.g. morning digest)
    audio_meta = None
    audio_path = result.metadata.get("audio_path", "")
    if audio_path:
        from pathlib import Path

        from openjarvis.server.models import AudioMeta

        if Path(audio_path).exists():
            audio_meta = AudioMeta(url="/api/digest/audio")

    return ChatCompletionResponse(
        model=model,
        choices=[
            Choice(
                message=ChoiceMessage(
                    role="assistant",
                    content=result.content,
                    audio=audio_meta,
                ),
                finish_reason="stop",
            )
        ],
        usage=usage,
        complexity=complexity_info,
    )


async def _handle_agent_stream(agent, bus, model, req):
    """Stream agent response with EventBus events via SSE."""
    from openjarvis.server.stream_bridge import create_agent_stream

    return await create_agent_stream(agent, bus, model, req)


async def _handle_stream(
    engine,
    model: str,
    req: ChatCompletionRequest,
    complexity_info=None,
):
    """Stream response using SSE format."""
    from openjarvis.server.cloud_router import (
        is_cloud_model,
        stream_cloud,
        stream_local,
    )

    messages = _to_messages(req.messages)
    chunk_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

    # Route directly to the right backend — bypasses engine routing entirely
    # so broken MultiEngine state can never misdirect requests.
    use_cloud = is_cloud_model(model)

    async def generate():
        # Send role chunk first
        first_chunk = ChatCompletionChunk(
            id=chunk_id,
            model=model,
            choices=[
                StreamChoice(
                    delta=DeltaMessage(role="assistant"),
                )
            ],
        )
        yield f"data: {first_chunk.model_dump_json()}\n\n"

        try:
            # Cloud models → direct cloud API (reads keys from disk).
            # Local models → engine.stream() first so mock engines work in
            # tests.  Fall back to stream_local() only when the engine would
            # mis-route the request to a cloud backend (MultiEngine routing
            # confusion), which is detected by checking the routed engine's
            # is_cloud attribute.
            if use_cloud:
                token_iter = stream_cloud(
                    model, messages, req.temperature, req.max_tokens
                )
            else:
                # Use engine.stream() by default (preserves mock-engine
                # compatibility in tests).  Only fall back to stream_local()
                # when a real MultiEngine would mis-route the local model to a
                # cloud backend — detected via isinstance so mocks are not
                # accidentally matched.
                _use_local_fallback = False
                try:
                    from openjarvis.engine.multi import MultiEngine

                    _inner = getattr(engine, "_inner", engine)
                    if isinstance(_inner, MultiEngine):
                        _routed = _inner._engine_for(model)
                        if _routed is not None and getattr(_routed, "is_cloud", False):
                            _use_local_fallback = True
                except Exception:
                    pass
                if _use_local_fallback:
                    token_iter = stream_local(
                        model, messages, req.temperature, req.max_tokens
                    )
                else:
                    token_iter = engine.stream(
                        messages,
                        model=model,
                        temperature=req.temperature,
                        max_tokens=req.max_tokens,
                    )
            async for token in token_iter:
                chunk = ChatCompletionChunk(
                    id=chunk_id,
                    model=model,
                    choices=[
                        StreamChoice(
                            delta=DeltaMessage(content=token),
                        )
                    ],
                )
                yield f"data: {chunk.model_dump_json()}\n\n"
        except Exception as exc:
            # Surface errors as a content chunk so the frontend can
            # display them instead of silently failing.
            import logging

            logging.getLogger("openjarvis.server").error(
                "Stream error: %s",
                exc,
                exc_info=True,
            )
            error_chunk = ChatCompletionChunk(
                id=chunk_id,
                model=model,
                choices=[
                    StreamChoice(
                        delta=DeltaMessage(
                            content=f"\n\nError during generation: {exc}",
                        ),
                        finish_reason="stop",
                    )
                ],
            )
            yield f"data: {error_chunk.model_dump_json()}\n\n"
            yield "data: [DONE]\n\n"
            return

        # Send finish chunk with usage data if available
        import json as _json

        finish_data = ChatCompletionChunk(
            id=chunk_id,
            model=model,
            choices=[
                StreamChoice(
                    delta=DeltaMessage(),
                    finish_reason="stop",
                )
            ],
        )
        finish_dict = _json.loads(finish_data.model_dump_json())

        # Tag the finish chunk with the correct engine label.
        # We use the routing decision (use_cloud) directly rather than
        # unwrapping the engine chain, which can be in a broken state.
        finish_dict.setdefault("telemetry", {})
        finish_dict["telemetry"]["engine"] = "cloud" if use_cloud else "ollama"

        if complexity_info is not None:
            finish_dict["complexity"] = complexity_info.model_dump()

        yield f"data: {_json.dumps(finish_dict)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )


@router.get("/v1/models")
async def list_models(request: Request) -> ModelListResponse:
    """List locally installed models (Ollama).

    Cloud models are not included here — they live in the Cloud Models tab
    of the UI and are selected there, not from this endpoint.
    """
    from openjarvis.server.cloud_router import is_cloud_model, list_local_models

    # Prefer engine.list_models() so mock engines work in tests.
    # Filter out any cloud model IDs that may appear via MultiEngine.
    # Fall back to direct Ollama query only when the engine returns nothing.
    engine = request.app.state.engine
    all_ids = engine.list_models()
    model_ids = [m for m in all_ids if not is_cloud_model(m)]
    if not model_ids:
        model_ids = await list_local_models()

    preferred = getattr(request.app.state, "model", "") or ""
    configured = ""
    cfg = getattr(request.app.state, "config", None)
    if cfg is not None:
        configured = (
            getattr(cfg.server, "model", "") or getattr(cfg.intelligence, "default_model", "")
        )

    rank_order = [
        configured,
        preferred,
        "qwen3.5:4b",
        "qwen3.5:2b",
        "qwen3.5:0.8b",
        "qwen3:0.6b",
    ]
    rank_map = {model_id: idx for idx, model_id in enumerate([m for m in rank_order if m])}
    model_ids = sorted(
        model_ids,
        key=lambda mid: (rank_map.get(mid, 10_000), mid),
    )

    return ModelListResponse(
        data=[ModelObject(id=mid) for mid in model_ids],
    )


@router.post("/v1/models/pull")
async def pull_model(request: Request):
    """Pull / download a model from the Ollama registry."""
    body = await request.json()
    model_name = body.get("model", "").strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="'model' field is required")

    engine = request.app.state.engine
    engine_name = getattr(request.app.state, "engine_name", "")
    # Only Ollama supports pulling
    if engine_name != "ollama" and getattr(engine, "engine_id", "") != "ollama":
        raise HTTPException(
            status_code=501,
            detail="Model pulling is only supported with the Ollama engine",
        )

    import httpx as _httpx

    host = getattr(engine, "_host", "http://127.0.0.1:11434")
    client = _httpx.Client(base_url=host, timeout=600.0)
    try:
        resp = client.post(
            "/api/pull",
            json={"name": model_name, "stream": False},
        )
        resp.raise_for_status()
    except (_httpx.ConnectError, _httpx.TimeoutException) as exc:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {exc}")
    except _httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"Ollama error: {exc.response.text[:300]}",
        )
    finally:
        client.close()

    return {"status": "ok", "model": model_name}


@router.delete("/v1/models/{model_name:path}")
async def delete_model(model_name: str, request: Request):
    """Delete a model from Ollama."""
    engine = request.app.state.engine
    engine_name = getattr(request.app.state, "engine_name", "")
    if engine_name != "ollama" and getattr(engine, "engine_id", "") != "ollama":
        raise HTTPException(status_code=501, detail="Only supported with Ollama engine")

    import httpx as _httpx

    host = getattr(engine, "_host", "http://127.0.0.1:11434")
    client = _httpx.Client(base_url=host, timeout=30.0)
    try:
        resp = client.request(
            "DELETE",
            "/api/delete",
            json={"name": model_name},
        )
        resp.raise_for_status()
    except (_httpx.ConnectError, _httpx.TimeoutException) as exc:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {exc}")
    except _httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=exc.response.status_code,
            detail=f"Ollama error: {exc.response.text[:300]}",
        )
    finally:
        client.close()

    return {"status": "deleted", "model": model_name}


@router.post("/v1/cloud/reload")
async def reload_cloud_engine(request: Request):
    """Hot-reload cloud API keys and (re-)initialize the cloud engine.

    Called by the desktop app immediately after the user saves a cloud API
    key so that cloud models become available without a full app restart.
    """
    import os
    from pathlib import Path

    # Re-read ~/.openjarvis/cloud-keys.env and update the running process env.
    keys_path = Path.home() / ".openjarvis" / "cloud-keys.env"
    if keys_path.exists():
        for raw_line in keys_path.read_text().splitlines():
            line = raw_line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ[k.strip()] = v.strip()

    # Try to build a fresh CloudEngine.
    try:
        from openjarvis.engine.cloud import CloudEngine
        from openjarvis.engine.multi import MultiEngine

        cloud = CloudEngine()
        if not cloud.health():
            return {
                "status": "no_cloud",
                "message": "No cloud models available (check API keys)",
            }
    except Exception as exc:
        return {"status": "error", "message": str(exc)}

    # Locate the innermost engine, working through InstrumentedEngine layers.
    outer = request.app.state.engine
    inner = getattr(outer, "_inner", outer)

    if isinstance(inner, MultiEngine):
        # Replace or insert the cloud entry in the existing MultiEngine.
        new_engines = [(k, e) for k, e in inner._engines if k != "cloud"]
        new_engines.append(("cloud", cloud))
        inner._engines = new_engines
        inner._refresh_map()
    else:
        # Wrap the existing engine (which may be security-wrapped) with a new
        # MultiEngine that includes the cloud engine.
        engine_name = getattr(request.app.state, "engine_name", "local")
        new_multi = MultiEngine([(engine_name, inner), ("cloud", cloud)])
        if hasattr(outer, "_inner"):
            outer._inner = new_multi
        else:
            request.app.state.engine = new_multi
        request.app.state.engine_name = "multi"

    return {"status": "ok", "message": "Cloud engine reloaded"}


@router.get("/v1/savings")
async def savings(request: Request):
    """Return savings summary compared to cloud providers.

    Only includes telemetry from the current server session so that
    counters start at zero each time a new model + agent is launched.
    """
    from openjarvis.core.config import DEFAULT_CONFIG_DIR
    from openjarvis.server.savings import compute_savings, savings_to_dict
    from openjarvis.telemetry.aggregator import TelemetryAggregator

    db_path = DEFAULT_CONFIG_DIR / "telemetry.db"
    if not db_path.exists():
        empty = compute_savings(0, 0, 0)
        return savings_to_dict(empty)

    session_start = getattr(request.app.state, "session_start", None)

    agg = TelemetryAggregator(db_path)
    try:
        summary = agg.summary(since=session_start)
        # Exclude cloud model tokens from savings — only local
        # inference counts toward cost savings.
        _cloud_prefixes = (
            "gpt-",
            "o1-",
            "o3-",
            "o4-",
            "claude-",
            "gemini-",
            "openrouter/",
        )
        local_models = [
            m
            for m in summary.per_model
            if not any(m.model_id.startswith(p) for p in _cloud_prefixes)
        ]
        result = compute_savings(
            prompt_tokens=sum(m.prompt_tokens for m in local_models),
            completion_tokens=sum(m.completion_tokens for m in local_models),
            total_calls=sum(m.call_count for m in local_models),
            session_start=session_start if session_start else 0.0,
            prompt_tokens_evaluated=sum(
                m.prompt_tokens_evaluated for m in local_models
            ),
        )
        return savings_to_dict(result)
    finally:
        agg.close()


@router.post("/v1/telemetry/reset")
async def reset_telemetry():
    """Clear all stored telemetry records.

    Useful after updating token-counting methodology — clears
    historical records that were computed under the old rules so
    that the savings dashboard and leaderboard submissions start
    fresh with corrected values.
    """
    from openjarvis.core.config import DEFAULT_CONFIG_DIR
    from openjarvis.telemetry.aggregator import TelemetryAggregator

    db_path = DEFAULT_CONFIG_DIR / "telemetry.db"
    if not db_path.exists():
        return {"status": "ok", "records_cleared": 0}

    agg = TelemetryAggregator(db_path)
    try:
        count = agg.clear()
    finally:
        agg.close()
    return {"status": "ok", "records_cleared": count}


@router.get("/v1/info")
async def server_info(request: Request):
    """Return server configuration: model, agent, engine."""
    agent = getattr(request.app.state, "agent", None)
    agent_id = getattr(agent, "agent_id", None) if agent else None
    # Fall back to configured agent name if agent didn't instantiate
    if agent_id is None:
        agent_id = getattr(request.app.state, "agent_name", None)
    return {
        "model": getattr(request.app.state, "model", ""),
        "agent": agent_id,
        "engine": getattr(request.app.state, "engine_name", ""),
    }


@router.get("/health")
async def health(request: Request):
    """Health check endpoint."""
    engine = request.app.state.engine
    healthy = await run_in_threadpool(engine.health)
    if not healthy:
        raise HTTPException(status_code=503, detail="Engine unhealthy")
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Channel endpoints
# ---------------------------------------------------------------------------


@router.get("/v1/channels")
async def list_channels(request: Request):
    """List available messaging channels."""
    bridge = getattr(request.app.state, "channel_bridge", None)
    if bridge is None:
        return {"channels": [], "message": "Channel bridge not configured"}
    channels = bridge.list_channels()
    return {"channels": channels, "status": bridge.status().value}


@router.post("/v1/channels/send")
async def channel_send(request: Request):
    """Send a message to a channel."""
    bridge = getattr(request.app.state, "channel_bridge", None)
    if bridge is None:
        raise HTTPException(status_code=503, detail="Channel bridge not configured")

    body = await request.json()
    channel_name = body.get("channel", "")
    content = body.get("content", "")
    conversation_id = body.get("conversation_id", "")

    if not channel_name or not content:
        raise HTTPException(
            status_code=400,
            detail="'channel' and 'content' are required",
        )

    ok = bridge.send(channel_name, content, conversation_id=conversation_id)
    if not ok:
        raise HTTPException(status_code=502, detail="Failed to send message")
    return {"status": "sent", "channel": channel_name}


@router.get("/v1/channels/status")
async def channel_status(request: Request):
    """Return channel bridge connection status."""
    bridge = getattr(request.app.state, "channel_bridge", None)
    if bridge is None:
        return {"status": "not_configured"}
    return {"status": bridge.status().value}


# ---------------------------------------------------------------------------
# Security scan endpoint
# ---------------------------------------------------------------------------


@router.get("/v1/security/scan")
async def security_scan():
    """Run a read-only security environment audit and return findings."""
    from openjarvis.cli.scan_cmd import PrivacyScanner

    scanner = PrivacyScanner()
    results = scanner.run_all()
    return {
        "has_warnings": any(r.status == "warn" for r in results),
        "has_failures": any(r.status == "fail" for r in results),
        "findings": [
            {
                "name": r.name,
                "status": r.status,
                "message": r.message,
                "platform": r.platform,
            }
            for r in results
        ],
    }


__all__ = ["router"]
