import { useEffect, useRef } from 'react';
import { api, getToken } from './api';

/**
 * Subscribes to the server's SSE stream (/api/sync/events) and invokes
 * `onEvent(eventName, data)` for each message. Falls back silently if the
 * connection drops — callers should keep their own polling as a backstop.
 */
export function useSSE(onEvent, enabled = true) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    if (!enabled || !getToken()) return undefined;

    let es;
    let retryDelay = 10_000;
    let retryTimer;
    let closed = false;

    function connect() {
      if (closed) return;
      es = new EventSource(api.sync.eventsUrl());

      es.addEventListener('connected', () => {
        retryDelay = 10_000;
      });
      es.addEventListener('conversations_updated', (e) => handlerRef.current?.('conversations_updated', safeParse(e.data)));
      es.addEventListener('new_message', (e) => handlerRef.current?.('new_message', safeParse(e.data)));

      es.onerror = () => {
        es.close();
        if (closed) return;
        retryTimer = setTimeout(() => {
          retryDelay = Math.min(retryDelay * 2, 60_000);
          connect();
        }, retryDelay);
      };
    }

    function safeParse(raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      es?.close();
    };
  }, [enabled]);
}
