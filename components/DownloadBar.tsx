"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { downloadAllAsZip } from "@/lib/utils";
import type { ConvertibleFile } from "@/types/converter";
import { Download, Package, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  files: ConvertibleFile[];
}

export function DownloadBar({ files }: Props) {
  const [zipping, setZipping] = useState(false);

  const done = files.filter(
    (f) => f.status === "done" && f.outputBlob && f.outputFilename,
  );
  if (done.length < 2) return null;

  const handleZip = async () => {
    setZipping(true);
    try {
      await downloadAllAsZip(
        done.map((f) => ({ blob: f.outputBlob!, filename: f.outputFilename! })),
      );
      toast.success("ZIP downloaded");
    } catch {
      toast.error("Failed to create ZIP");
    } finally {
      setZipping(false);
    }
  };

  return (
    <div className="fixed bottom-0 inset-x-0 z-50 border-t bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
          <Package className="w-4 h-4 shrink-0" />
          <span className="truncate">
            <span className="font-semibold text-foreground">{done.length}</span>{" "}
            files ready
          </span>
        </div>
        <Button
          size="sm"
          onClick={handleZip}
          disabled={zipping}
          className="gap-2 shrink-0"
        >
          {zipping ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Download className="w-3.5 h-3.5" />
          )}
          <span className="hidden sm:inline">
            {zipping ? "Zipping…" : "Download all as ZIP"}
          </span>
          <span className="sm:hidden">
            {zipping ? "Zipping…" : "Download ZIP"}
          </span>
        </Button>
      </div>
    </div>
  );
}
