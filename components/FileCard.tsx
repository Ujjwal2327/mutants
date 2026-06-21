"use client";

import { useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { FormatSelector } from "@/components/FormatSelector";
import { downloadBlob, formatBytes } from "@/lib/utils";
import { getTargets } from "@/lib/formatRegistry";
import type { ConvertibleFile } from "@/types/converter";
import {
  FileIcon,
  CheckCircle2,
  XCircle,
  Loader2,
  Download,
  X,
  ArrowRight,
  RefreshCw,
  Ban,
} from "lucide-react";

interface Props {
  file: ConvertibleFile;
  onFormatChange: (id: string, fmt: string) => void;
  onConvert: (id: string) => void;
  onCancel: (id: string) => void;
  onRemove: (id: string) => void;
}

function formatDuration(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) {
    return min >= 10 || sec === 0 ? `${min}m` : `${min}m ${sec}s`;
  }
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin === 0 ? `${hr}h` : `${hr}h ${remMin}m`;
}

function remainingLabel(file: ConvertibleFile): string {
  if (!file.startedAt) return "Converting…";
  const elapsedMs = Date.now() - file.startedAt;

  if (file.loadingEngine) {
    return "Loading converter engine (one-time download)…";
  }

  if (file.usesRealProgress) {
    // Only derive a time estimate once we have meaningful progress (≥5%).
    // Below that threshold the division produces unreliably large numbers.
    if (file.progress < 5) return "Starting…";
    const totalEstimate = elapsedMs / (file.progress / 100);
    const remainingMs = totalEstimate - elapsedMs;
    if (remainingMs <= 1500) return "Almost done…";
    return `~${formatDuration(remainingMs)} left`;
  }

  // Simulated (exponential-decay) progress path — driven by estimatedMs.
  if (!file.estimatedMs) return `Converting… ${formatDuration(elapsedMs)}`;
  // After 3× the estimate has elapsed, just show elapsed time.
  if (elapsedMs > file.estimatedMs * 3) {
    return `Still working… ${formatDuration(elapsedMs)} elapsed`;
  }
  const remainingMs = file.estimatedMs - elapsedMs;
  if (remainingMs <= 1000) return "Almost done…";
  return `~${formatDuration(remainingMs)} left`;
}

export function FileCard({
  file,
  onFormatChange,
  onConvert,
  onCancel,
  onRemove,
}: Props) {
  const targets = getTargets(file.inputFormat);
  const isConverting = file.status === "converting";
  const isDone = file.status === "done";
  const isError = file.status === "error";
  const isCancelled = file.status === "cancelled";

  const handleDownload = useCallback(() => {
    if (file.outputBlob && file.outputFilename)
      downloadBlob(file.outputBlob, file.outputFilename);
  }, [file.outputBlob, file.outputFilename]);

  return (
    <Card
      className={`p-3.5 sm:p-4 flex flex-col gap-3 transition-colors duration-200 ${
        isDone
          ? "border-green-200 bg-green-50/30 dark:border-green-900 dark:bg-green-950/20"
          : isError
            ? "border-red-200 bg-red-50/30 dark:border-red-900 dark:bg-red-950/20"
            : isConverting
              ? "border-blue-200 bg-blue-50/30 dark:border-blue-900 dark:bg-blue-950/20"
              : isCancelled
                ? "border-orange-200 bg-orange-50/30 dark:border-orange-900 dark:bg-orange-950/20"
                : ""
      }`}
    >
      {/* Header: icon + filename + remove */}
      <div className="flex items-start gap-2">
        <FileIcon className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-medium truncate leading-tight"
            title={file.file.name}
          >
            {file.file.name}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {formatBytes(file.file.size)}
          </p>
        </div>
        <button
          onClick={() => onRemove(file.id)}
          disabled={isConverting}
          className="text-muted-foreground hover:text-foreground transition-colors shrink-0 disabled:opacity-30 p-1.5 -m-1.5 rounded-md"
          aria-label="Remove"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Format row */}
      <div className="flex items-center gap-2">
        <Badge
          variant="outline"
          className="font-mono uppercase text-[10px] shrink-0"
        >
          .{file.inputFormat}
        </Badge>
        <ArrowRight className="w-3 h-3 text-muted-foreground shrink-0" />
        <FormatSelector
          targets={targets}
          value={file.outputFormat}
          onChange={(fmt) => onFormatChange(file.id, fmt)}
          disabled={isConverting}
        />
        <div className="ml-auto shrink-0">
          {isConverting && (
            <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
          )}
          {isDone && <CheckCircle2 className="w-4 h-4 text-green-500" />}
          {isError && <XCircle className="w-4 h-4 text-red-500" />}
          {isCancelled && <Ban className="w-4 h-4 text-orange-400" />}
        </div>
      </div>

      {/* Progress bar + cancel button */}
      {isConverting && (
        <div className="space-y-1.5">
          <Progress value={file.progress} className="h-1" />
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center justify-between flex-1 text-[11px] text-muted-foreground tabular-nums min-w-0">
              <span className="truncate">{remainingLabel(file)}</span>
              <span className="shrink-0 ml-1">{file.progress}%</span>
            </div>
            <button
              onClick={() => onCancel(file.id)}
              className="shrink-0 text-[11px] text-orange-500 hover:text-orange-600 dark:text-orange-400 dark:hover:text-orange-300 transition-colors font-medium leading-none"
              aria-label="Cancel conversion"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {isError && file.errorMessage && (
        <p className="text-[11px] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 rounded px-2 py-1 font-mono break-all leading-snug">
          {file.errorMessage}
        </p>
      )}

      {/* Cancelled notice */}
      {isCancelled && (
        <p className="text-[11px] text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-950/40 rounded px-2 py-1 leading-snug">
          Conversion cancelled
        </p>
      )}

      {/* Action button */}
      {isDone ? (
        <div className="flex gap-1.5">
          <Button
            size="sm"
            className="h-8 text-xs gap-1.5 flex-1 min-w-0"
            onClick={handleDownload}
          >
            <Download className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Download .{file.outputFormat}</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0 shrink-0"
            title="Pick a new format above to re-convert"
            onClick={() => onFormatChange(file.id, file.outputFormat)}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant={isError ? "destructive" : "default"}
          className="h-8 text-xs w-full"
          onClick={() => onConvert(file.id)}
          disabled={isConverting || !file.outputFormat}
        >
          {isConverting
            ? "Converting…"
            : isError
              ? "Retry"
              : isCancelled
                ? "Convert again"
                : "Convert"}
        </Button>
      )}
    </Card>
  );
}
