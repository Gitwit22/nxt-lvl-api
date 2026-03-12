/**
 * Manual Entry Form Component
 *
 * Allows staff to manually create a document record
 * with metadata, without needing to upload a file.
 * Files or additional metadata can be attached later.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PenLine, Loader2 } from "lucide-react";
import { DOCUMENT_CATEGORIES, DOCUMENT_TYPES } from "@/types/document";
import type { DocumentCategory, DocumentType } from "@/types/document";
import { useManualEntry } from "@/hooks/useDocuments";
import { toast } from "sonner";

interface ManualEntryFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ManualEntryForm = ({ open, onOpenChange }: ManualEntryFormProps) => {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState("");
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [category, setCategory] = useState<DocumentCategory>("Uncategorized");
  const [type, setType] = useState<DocumentType>("Other");
  const [tags, setTags] = useState("");
  const [department, setDepartment] = useState("");
  const [extractedText, setExtractedText] = useState("");

  const manualEntry = useManualEntry();

  const resetForm = () => {
    setTitle("");
    setDescription("");
    setAuthor("");
    setYear(String(new Date().getFullYear()));
    setCategory("Uncategorized");
    setType("Other");
    setTags("");
    setDepartment("");
    setExtractedText("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!title.trim()) {
      toast.error("Title is required");
      return;
    }

    try {
      manualEntry.mutate(
        {
          title: title.trim(),
          description: description.trim(),
          author: author.trim() || undefined,
          year: Number(year) || new Date().getFullYear(),
          category,
          type,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          department: department.trim() || undefined,
          extractedText: extractedText.trim() || undefined,
        },
        {
          onSuccess: () => {
            toast.success("Document record created successfully");
            resetForm();
            onOpenChange(false);
          },
          onError: (error) => {
            toast.error(
              `Failed to create record: ${error instanceof Error ? error.message : "Unknown error"}`
            );
          },
        }
      );
    } catch (error) {
      toast.error("Failed to create document record");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-bold flex items-center gap-2">
            <PenLine className="h-5 w-5" />
            Manual Document Entry
          </DialogTitle>
          <DialogDescription className="font-body text-sm text-muted-foreground">
            Create a document record manually. Files can be attached later.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 mt-4">
          {/* Title */}
          <div className="space-y-2">
            <Label htmlFor="title" className="font-body font-medium">
              Title <span className="text-destructive">*</span>
            </Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Document title"
              className="font-body"
              required
            />
          </div>

          {/* Description */}
          <div className="space-y-2">
            <Label htmlFor="description" className="font-body font-medium">
              Description
            </Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description of the document"
              className="font-body"
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Author */}
            <div className="space-y-2">
              <Label htmlFor="author" className="font-body font-medium">
                Author
              </Label>
              <Input
                id="author"
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="Author or creator"
                className="font-body"
              />
            </div>

            {/* Year */}
            <div className="space-y-2">
              <Label htmlFor="year" className="font-body font-medium">
                Year
              </Label>
              <Input
                id="year"
                type="number"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                placeholder="e.g. 2024"
                className="font-body"
                min="1900"
                max="2100"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Category */}
            <div className="space-y-2">
              <Label className="font-body font-medium">Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as DocumentCategory)}>
                <SelectTrigger className="font-body">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  {DOCUMENT_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Type */}
            <div className="space-y-2">
              <Label className="font-body font-medium">Type</Label>
              <Select value={type} onValueChange={(v) => setType(v as DocumentType)}>
                <SelectTrigger className="font-body">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {DOCUMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Tags */}
          <div className="space-y-2">
            <Label htmlFor="tags" className="font-body font-medium">
              Tags
            </Label>
            <Input
              id="tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="Comma-separated tags (e.g. housing, equity, Detroit)"
              className="font-body"
            />
          </div>

          {/* Department */}
          <div className="space-y-2">
            <Label htmlFor="department" className="font-body font-medium">
              Department / Program
            </Label>
            <Input
              id="department"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              placeholder="e.g. Housing Division, Youth Programs"
              className="font-body"
            />
          </div>

          {/* Extracted Text / Content */}
          <div className="space-y-2">
            <Label htmlFor="extractedText" className="font-body font-medium">
              Document Content / Text
            </Label>
            <Textarea
              id="extractedText"
              value={extractedText}
              onChange={(e) => setExtractedText(e.target.value)}
              placeholder="Paste or type the document content here for search indexing"
              className="font-body"
              rows={5}
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={manualEntry.isPending}
              className="font-body"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={manualEntry.isPending}
              className="gap-2 font-body bg-primary hover:bg-primary/90"
            >
              {manualEntry.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <PenLine className="h-4 w-4" />
                  Create Record
                </>
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default ManualEntryForm;
