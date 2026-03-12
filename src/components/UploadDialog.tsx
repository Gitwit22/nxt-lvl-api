/**
 * Upload Dialog Component
 *
 * Provides multiple document intake methods in a single dialog:
 * - Drag and drop
 * - Single/multi file selection
 * - Folder upload
 * - Scanner import
 */

import { useState, useCallback, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Upload,
  FolderOpen,
  ScanLine,
  FileText,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from "lucide-react";
import {
  useUploadMultipleFiles,
  useBulkUpload,
  useScannerImport,
} from "@/hooks/useDocuments";
import { toast } from "sonner";

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const UploadDialog = ({ open, onOpenChange }: UploadDialogProps) => {
  const [dragActive, setDragActive] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadMode, setUploadMode] = useState<"files" | "folder" | "scanner">("files");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const scannerInputRef = useRef<HTMLInputElement>(null);

  const uploadMultiple = useUploadMultipleFiles();
  const bulkUpload = useBulkUpload();
  const scannerImport = useScannerImport();

  const isUploading =
    uploadMultiple.isPending || bulkUpload.isPending || scannerImport.isPending;

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setSelectedFiles((prev) => [...prev, ...files]);
    }
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length > 0) {
      setSelectedFiles((prev) => [...prev, ...files]);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) return;

    try {
      switch (uploadMode) {
        case "folder":
          await bulkUpload.mutateAsync({ files: selectedFiles });
          break;
        case "scanner":
          await scannerImport.mutateAsync({ files: selectedFiles });
          break;
        case "files":
        default:
          await uploadMultiple.mutateAsync({ files: selectedFiles });
          break;
      }
      toast.success(`${selectedFiles.length} document(s) uploaded and queued for processing`);
      setSelectedFiles([]);
      onOpenChange(false);
    } catch (error) {
      toast.error(
        `Upload failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-bold">
            Upload Documents
          </DialogTitle>
          <DialogDescription className="font-body text-sm text-muted-foreground">
            Add documents to the archive using any of the methods below.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={uploadMode}
          onValueChange={(v) => {
            setUploadMode(v as typeof uploadMode);
            setSelectedFiles([]);
          }}
          className="mt-4"
        >
          <TabsList className="w-full">
            <TabsTrigger value="files" className="flex-1 gap-2 font-body">
              <Upload className="h-4 w-4" />
              Files
            </TabsTrigger>
            <TabsTrigger value="folder" className="flex-1 gap-2 font-body">
              <FolderOpen className="h-4 w-4" />
              Folder
            </TabsTrigger>
            <TabsTrigger value="scanner" className="flex-1 gap-2 font-body">
              <ScanLine className="h-4 w-4" />
              Scanner
            </TabsTrigger>
          </TabsList>

          {/* File Upload Tab */}
          <TabsContent value="files" className="space-y-4">
            {/* Drag and Drop Zone */}
            <div
              className={`relative border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                dragActive
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50"
              }`}
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
            >
              <Upload className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-body text-sm text-foreground mb-1">
                Drag & drop files here, or{" "}
                <button
                  type="button"
                  className="text-primary underline hover:text-primary/80"
                  onClick={() => fileInputRef.current?.click()}
                >
                  browse files
                </button>
              </p>
              <p className="font-body text-xs text-muted-foreground">
                Supports PDF, images, Word, Excel, text files, and more
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileSelect}
                accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.png,.jpg,.jpeg,.tiff,.bmp,.webp,.html,.md"
              />
            </div>
          </TabsContent>

          {/* Folder Upload Tab */}
          <TabsContent value="folder" className="space-y-4">
            <div className="border-2 border-dashed rounded-xl p-8 text-center border-border hover:border-primary/50 transition-colors">
              <FolderOpen className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-body text-sm text-foreground mb-1">
                <button
                  type="button"
                  className="text-primary underline hover:text-primary/80"
                  onClick={() => folderInputRef.current?.click()}
                >
                  Select a folder
                </button>{" "}
                to upload all files within it
              </p>
              <p className="font-body text-xs text-muted-foreground">
                Folder structure will be preserved as source references
              </p>
              <input
                ref={folderInputRef}
                type="file"
                /* @ts-expect-error webkitdirectory is a non-standard attribute */
                webkitdirectory=""
                multiple
                className="hidden"
                onChange={handleFileSelect}
              />
            </div>
          </TabsContent>

          {/* Scanner Import Tab */}
          <TabsContent value="scanner" className="space-y-4">
            <div className="border-2 border-dashed rounded-xl p-8 text-center border-border hover:border-primary/50 transition-colors">
              <ScanLine className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="font-body text-sm text-foreground mb-1">
                <button
                  type="button"
                  className="text-primary underline hover:text-primary/80"
                  onClick={() => scannerInputRef.current?.click()}
                >
                  Import scanned documents
                </button>
              </p>
              <p className="font-body text-xs text-muted-foreground">
                PDFs and images from scanners will be queued for OCR processing
              </p>
              <input
                ref={scannerInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileSelect}
                accept=".pdf,.png,.jpg,.jpeg,.tiff,.bmp"
              />
            </div>
          </TabsContent>
        </Tabs>

        {/* Selected Files List */}
        {selectedFiles.length > 0 && (
          <div className="space-y-2 mt-4">
            <div className="flex items-center justify-between">
              <span className="font-body text-sm font-medium text-foreground">
                {selectedFiles.length} file{selectedFiles.length !== 1 ? "s" : ""} selected
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedFiles([])}
                className="text-muted-foreground hover:text-foreground"
              >
                Clear all
              </Button>
            </div>
            <div className="max-h-48 overflow-y-auto space-y-1">
              {selectedFiles.map((file, i) => (
                <div
                  key={`${file.name}-${i}`}
                  className="flex items-center gap-2 px-3 py-2 bg-muted/50 rounded-md"
                >
                  <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="font-body text-sm text-foreground truncate flex-1">
                    {file.name}
                  </span>
                  <Badge variant="outline" className="text-xs font-body">
                    {formatFileSize(file.size)}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Upload Button */}
        <div className="flex justify-end gap-3 mt-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isUploading}
            className="font-body"
          >
            Cancel
          </Button>
          <Button
            onClick={handleUpload}
            disabled={selectedFiles.length === 0 || isUploading}
            className="gap-2 font-body bg-primary hover:bg-primary/90"
          >
            {isUploading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Processing...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4" />
                Upload {selectedFiles.length > 0 ? `(${selectedFiles.length})` : ""}
              </>
            )}
          </Button>
        </div>

        {/* Upload Status */}
        {uploadMultiple.isSuccess && (
          <div className="flex items-center gap-2 text-sm text-green-600 font-body">
            <CheckCircle2 className="h-4 w-4" />
            Upload completed successfully
          </div>
        )}
        {(uploadMultiple.isError || bulkUpload.isError || scannerImport.isError) && (
          <div className="flex items-center gap-2 text-sm text-destructive font-body">
            <AlertCircle className="h-4 w-4" />
            Upload failed. Please try again.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default UploadDialog;
