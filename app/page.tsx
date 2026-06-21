"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { Dropzone } from "@/components/Dropzone";
import { FileCard } from "@/components/FileCard";
import { DownloadBar } from "@/components/DownloadBar";
import { FormatSelector } from "@/components/FormatSelector";
import { ThemeToggle } from "@/components/ThemeToggle";
import { convert } from "@/lib/converters";
import {
  buildOutputFilename,
  getTargets,
  estimateConversionMs,
} from "@/lib/formatRegistry";
import { downloadBlob } from "@/lib/utils";
import type { ConvertibleFile } from "@/types/converter";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Zap, Trash2, Layers, XCircle } from "lucide-react";
import { toast } from "sonner";

export default function HomePage() {
  const [files, setFiles] = useState<ConvertibleFile[]>([]);

  // One AbortController per active conversion, keyed by file id.
  // Using a ref so mutations don't trigger re-renders.
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  const addFiles = useCallback((incoming: ConvertibleFile[]) => {
    setFiles((prev) => [...prev, ...incoming]);
  }, []);

  const removeFile = useCallback((id: string) => {
    // Cancel if converting before removing
    abortControllers.current.get(id)?.abort();
    abortControllers.current.delete(id);
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    // Cancel every active conversion
    for (const ctrl of abortControllers.current.values()) ctrl.abort();
    abortControllers.current.clear();
    setFiles([]);
  }, []);

  // ── Cancel a single conversion ────────────────────────────────────────────
  const cancelConversion = useCallback((id: string) => {
    abortControllers.current.get(id)?.abort();
    abortControllers.current.delete(id);
    setFiles((prev) =>
      prev.map((f) =>
        f.id === id
          ? {
              ...f,
              status: "cancelled",
              progress: 0,
              loadingEngine: false,
              usesRealProgress: false,
              errorMessage: undefined,
            }
          : f,
      ),
    );
    toast.info("Conversion cancelled");
  }, []);

  // ── Cancel every active conversion ────────────────────────────────────────
  const cancelAll = useCallback(() => {
    const active = new Set([...abortControllers.current.keys()]);
    for (const ctrl of abortControllers.current.values()) ctrl.abort();
    abortControllers.current.clear();
    setFiles((prev) =>
      prev.map((f) =>
        active.has(f.id)
          ? {
              ...f,
              status: "cancelled",
              progress: 0,
              loadingEngine: false,
              usesRealProgress: false,
              errorMessage: undefined,
            }
          : f,
      ),
    );
    toast.info(
      `Cancelled ${active.size} conversion${active.size !== 1 ? "s" : ""}`,
    );
  }, []);

  const setFormatChange = useCallback((id: string, fmt: string) => {
    setFiles((prev) =>
      prev.map((f) =>
        f.id === id
          ? {
              ...f,
              outputFormat: fmt,
              status: "idle",
              progress: 0,
              outputBlob: undefined,
              outputFilename: undefined,
              errorMessage: undefined,
            }
          : f,
      ),
    );
  }, []);

  const setAllFormats = useCallback((fmt: string) => {
    setFiles((prev) =>
      prev.map((f) => ({
        ...f,
        outputFormat: fmt,
        status: "idle",
        progress: 0,
        outputBlob: undefined,
        outputFilename: undefined,
        errorMessage: undefined,
      })),
    );
  }, []);

  const runConversion = useCallback(async (id: string) => {
    const startedAt = Date.now();
    let estimatedMs = 1000;

    // Create a fresh AbortController for this job
    const controller = new AbortController();
    abortControllers.current.set(id, controller);
    const { signal } = controller;

    setFiles((prev) => {
      const file = prev.find((f) => f.id === id);
      if (!file || file.status === "converting") return prev;
      estimatedMs = estimateConversionMs(file.file, file.inputFormat);
      return prev.map((f) =>
        f.id === id
          ? {
              ...f,
              status: "converting",
              progress: 2,
              startedAt,
              estimatedMs,
              loadingEngine: false,
              usesRealProgress: false,
              errorMessage: undefined,
            }
          : f,
      );
    });

    const snapshot = await new Promise<ConvertibleFile | undefined>((res) =>
      setFiles((prev) => {
        res(prev.find((f) => f.id === id));
        return prev;
      }),
    );
    if (!snapshot) return;

    const CAP = 96;
    const ticker = setInterval(() => {
      setFiles((prev) =>
        prev.map((f) => {
          if (f.id !== id || f.status !== "converting") return f;
          if (f.usesRealProgress) return f;
          const elapsed = Date.now() - (f.startedAt ?? startedAt);
          const est = f.estimatedMs ?? estimatedMs;
          const factor = 1 - Math.exp((-1.6 * elapsed) / est);
          return {
            ...f,
            progress: Math.max(
              f.progress,
              Math.min(CAP, Math.round(CAP * factor)),
            ),
          };
        }),
      );
    }, 150);

    const handleProgress = (info: {
      phase: "loading" | "converting";
      ratio?: number;
    }) => {
      setFiles((prev) =>
        prev.map((f) => {
          if (f.id !== id || f.status !== "converting") return f;
          if (info.phase === "loading") return { ...f, loadingEngine: true };
          if (typeof info.ratio === "number") {
            const pct = Math.min(99, Math.round(info.ratio * 100));
            // Switch to real progress as soon as ffmpeg reports any meaningful
            // value (>0). The old guard of pct>=85 meant we ignored real progress
            // for almost the entire conversion and kept showing the simulated curve.
            return {
              ...f,
              loadingEngine: false,
              usesRealProgress: pct > 0 ? true : f.usesRealProgress,
              progress: pct > 0 ? Math.max(f.progress, pct) : f.progress,
            };
          }
          return { ...f, loadingEngine: false };
        }),
      );
    };

    try {
      const blob = await convert(
        snapshot.file,
        snapshot.outputFormat,
        handleProgress,
        signal,
      );

      // If aborted mid-flight (between the convert resolving and here)
      signal.throwIfAborted();

      const effectiveFormat =
        blob.type === "application/zip" && snapshot.outputFormat !== "zip"
          ? "zip"
          : snapshot.outputFormat;
      const outputFilename = buildOutputFilename(
        snapshot.file.name,
        effectiveFormat,
      );
      clearInterval(ticker);
      abortControllers.current.delete(id);
      setFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? {
                ...f,
                status: "done",
                progress: 100,
                outputBlob: blob,
                outputFilename,
              }
            : f,
        ),
      );
      downloadBlob(blob, outputFilename);
      toast.success(`Downloaded: ${outputFilename}`);
    } catch (err) {
      clearInterval(ticker);
      abortControllers.current.delete(id);

      // Distinguish a user-initiated abort from a real error
      if (
        (err instanceof DOMException && err.name === "AbortError") ||
        (err instanceof Error && err.message === "AbortError")
      ) {
        // cancelConversion() already set the status to 'cancelled' — nothing to do
        // But if the abort happened inside convert() before cancelConversion ran
        // (e.g. throwIfAborted at the top of convert()), set it now.
        setFiles((prev) =>
          prev.map((f) =>
            f.id === id && f.status === "converting"
              ? { ...f, status: "cancelled", progress: 0, loadingEngine: false }
              : f,
          ),
        );
        return;
      }

      const msg = err instanceof Error ? err.message : "Unknown error";
      setFiles((prev) =>
        prev.map((f) =>
          f.id === id
            ? { ...f, status: "error", progress: 0, errorMessage: msg }
            : f,
        ),
      );
      toast.error(`Failed: ${snapshot.file.name}`, { description: msg });
    }
  }, []);

  const convertAll = useCallback(() => {
    const ids = files
      .filter(
        (f) =>
          f.status === "idle" ||
          f.status === "error" ||
          f.status === "cancelled",
      )
      .map((f) => f.id);
    ids.forEach((id) => runConversion(id));
  }, [files, runConversion]);

  const commonTargets = useMemo(() => {
    if (files.length < 2) return [];
    return files
      .map((f) => getTargets(f.inputFormat))
      .reduce((acc, targets) => acc.filter((t) => targets.includes(t)));
  }, [files]);

  const uniformFmt = useMemo(() => {
    if (files.length < 2) return "";
    const first = files[0].outputFormat;
    return files.every((f) => f.outputFormat === first) ? first : "";
  }, [files]);

  const convertingCount = files.filter((f) => f.status === "converting").length;
  const pendingCount = files.filter(
    (f) =>
      f.status === "idle" || f.status === "error" || f.status === "cancelled",
  ).length;

  return (
    <main className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12 pb-28 space-y-6 sm:space-y-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1.5 min-w-0">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
              Mutants
            </h1>
            <p className="text-muted-foreground text-sm max-w-xl">
              Convert images, PDFs, documents, spreadsheets, data formats,
              archives, fonts, audio, and video — entirely in your browser.
              Files never leave your device.
            </p>
          </div>
          <ThemeToggle />
        </div>

        {/* Drop zone */}
        <Dropzone onFilesAdded={addFiles} />

        {/* File list */}
        {files.length > 0 && (
          <div className="space-y-4">
            <Separator />

            {/* Toolbar */}
            <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
              <p className="text-sm text-muted-foreground sm:flex-1 sm:min-w-0">
                {files.length} file{files.length !== 1 ? "s" : ""} queued
                {convertingCount > 0 && (
                  <span className="ml-1.5 text-blue-500 dark:text-blue-400">
                    · {convertingCount} converting
                  </span>
                )}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                {/* Batch format picker */}
                {commonTargets.length > 0 && (
                  <div className="flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1">
                    <Layers className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      Set all to
                    </span>
                    <FormatSelector
                      targets={commonTargets}
                      value={uniformFmt}
                      onChange={setAllFormats}
                    />
                  </div>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs gap-1.5"
                  onClick={clearAll}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear all
                </Button>

                {/* Cancel all — only when ≥2 conversions are running */}
                {convertingCount > 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs gap-1.5 border-orange-300 text-orange-600 hover:bg-orange-50 hover:text-orange-700 dark:border-orange-800 dark:text-orange-400 dark:hover:bg-orange-950/40"
                    onClick={cancelAll}
                  >
                    <XCircle className="w-3.5 h-3.5" />
                    Cancel all ({convertingCount})
                  </Button>
                )}

                {pendingCount > 1 && (
                  <Button
                    size="sm"
                    className="h-8 text-xs gap-1.5"
                    onClick={convertAll}
                  >
                    <Zap className="w-3.5 h-3.5" />
                    Convert all ({pendingCount})
                  </Button>
                )}
              </div>
            </div>

            {/* Cards grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {files.map((f) => (
                <FileCard
                  key={f.id}
                  file={f}
                  onFormatChange={setFormatChange}
                  onConvert={runConversion}
                  onCancel={cancelConversion}
                  onRemove={removeFile}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <DownloadBar files={files} />
    </main>
  );
}
