import { safeJsonStringify } from "./html.js";

export type RscEmbedTransform = {
  flush(): string;
  finalize(): Promise<string>;
};

/**
 * Fix invalid preload "as" values in RSC Flight hint lines before they reach
 * the client. React Flight emits HL hints with as="stylesheet" for CSS, but
 * the HTML spec requires as="style" for <link rel="preload">.
 */
export function fixFlightHints(text: string): string {
  return text.replace(/(\d*:HL\[.*?),"stylesheet"(\]|,)/g, '$1,"style"$2');
}

/**
 * Create a helper that progressively embeds RSC chunks as inline <script> tags.
 * The browser entry turns the embedded text chunks back into Uint8Array data.
 */
export function createRscEmbedTransform(
  embedStream: ReadableStream<Uint8Array>,
): RscEmbedTransform {
  const reader = embedStream.getReader();
  const decoder = new TextDecoder();
  let pendingChunks: string[] = [];
  let reading = false;

  async function pumpReader(): Promise<void> {
    if (reading) return;
    reading = true;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        const text = decoder.decode(result.value, { stream: true });
        // The RSC entry already fixes HL hints at the source. Keep this second
        // pass as defense in depth for any embed stream that bypasses that
        // wrapper; the rewrite is idempotent, so double-application is safe.
        pendingChunks.push(fixFlightHints(text));
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "production") {
        console.warn("[vinext] RSC embed stream read error:", error);
      }
    } finally {
      reading = false;
    }
  }

  const pumpPromise = pumpReader();

  return {
    flush(): string {
      if (pendingChunks.length === 0) return "";

      const chunks = pendingChunks;
      pendingChunks = [];

      let scripts = "";
      for (const chunk of chunks) {
        scripts +=
          "<script>self.__VINEXT_RSC_CHUNKS__=self.__VINEXT_RSC_CHUNKS__||[];self.__VINEXT_RSC_CHUNKS__.push(" +
          safeJsonStringify(chunk) +
          ")</script>";
      }
      return scripts;
    },

    async finalize(): Promise<string> {
      await pumpPromise;
      let scripts = this.flush();
      scripts += "<script>self.__VINEXT_RSC_DONE__=true</script>";
      return scripts;
    },
  };
}

/**
 * Fix invalid preload "as" values in server-rendered HTML.
 * React Fizz emits <link rel="preload" as="stylesheet"> for CSS, but the
 * HTML spec requires as="style" for <link rel="preload">.
 */
export function fixPreloadAs(html: string): string {
  return html.replace(/<link(?=[^>]*\srel="preload")[^>]*>/g, (tag) =>
    tag.replace(' as="stylesheet"', ' as="style"'),
  );
}

/**
 * Create the tick-buffered HTML transform that injects RSC scripts between
 * React Fizz flush cycles without corrupting split HTML chunks.
 */
export function createTickBufferedTransform(
  rscEmbed: RscEmbedTransform,
  injectHTML = "",
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let injected = false;
  let buffered: string[] = [];
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  // Hold back everything from "</body>" onwards so finalScripts can be
  // injected before </body></html> rather than appended after </html>.
  let trailer: string | null = null;

  const flushBuffered = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    for (const chunk of buffered) {
      let out = chunk;

      if (!injected) {
        const headEnd = out.indexOf("</head>");
        if (headEnd !== -1) {
          out = out.slice(0, headEnd) + injectHTML + out.slice(headEnd);
          injected = true;
        }
      }

      // Detect </body> and hold back from that point as the "trailer".
      // The trailer is emitted in flush() together with finalScripts so
      // the document always ends with …scripts…</body></html>.
      if (trailer === null) {
        const bodyEnd = out.lastIndexOf("</body>");
        if (bodyEnd !== -1) {
          const before = out.slice(0, bodyEnd);
          trailer = out.slice(bodyEnd); // "</body>...</html>"
          if (before) controller.enqueue(encoder.encode(before));
          continue;
        }
      } else {
        // Already have a trailer — accumulate subsequent content into it
        // (deferred Suspense scripts that arrive after </body> in the same
        // flush cycle).
        trailer += out;
        continue;
      }

      controller.enqueue(encoder.encode(out));
    }
    buffered = [];
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffered.push(fixPreloadAs(decoder.decode(chunk, { stream: true })));

      if (timeoutId !== null) return;

      timeoutId = setTimeout(() => {
        try {
          flushBuffered(controller);

          const rscScripts = rscEmbed.flush();
          if (rscScripts) {
            // If the trailer has already been captured, inject mid-stream RSC
            // scripts before </body> instead of after it.
            if (trailer !== null) {
              const bodyEnd = trailer.indexOf("</body>");
              if (bodyEnd !== -1) {
                trailer = trailer.slice(0, bodyEnd) + rscScripts + trailer.slice(bodyEnd);
              } else {
                trailer += rscScripts;
              }
            } else {
              controller.enqueue(encoder.encode(rscScripts));
            }
          }
        } catch {
          // Stream was cancelled between when the timeout was registered and
          // when it fired (e.g. client disconnected, health-check cancelled
          // the response body). Ignore — the stream is already closed.
        }

        timeoutId = null;
      }, 0);
    },

    async flush(controller) {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      flushBuffered(controller);

      if (!injected && injectHTML) {
        controller.enqueue(encoder.encode(injectHTML));
      }

      const finalScripts = await rscEmbed.finalize();

      // Emit the trailer (</body>...</html>) with finalScripts injected
      // just before </body> so the document always ends with </body></html>.
      if (trailer !== null) {
        const bodyEnd = trailer.indexOf("</body>");
        if (bodyEnd !== -1) {
          const combined =
            trailer.slice(0, bodyEnd) + (finalScripts || "") + trailer.slice(bodyEnd);
          controller.enqueue(encoder.encode(combined));
        } else {
          // Unexpected: no </body> in trailer — emit as-is with scripts appended
          controller.enqueue(encoder.encode(trailer + (finalScripts || "")));
        }
      } else if (finalScripts) {
        // Fallback: </body> was not seen anywhere (e.g. error/empty page)
        controller.enqueue(encoder.encode(finalScripts));
      }
    },
  });
}
