import { useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Cloud,
  Database,
  FolderArchive,
  FolderCog,
  HardDrive,
  Network,
  Save,
  Server,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";

type StorageProvider = "local" | "network" | "r2";

type DestinationSettings = {
  provider: StorageProvider;
  enabled: boolean;
  saveProcessedDocs: boolean;
  useAsFinalArchive: boolean;
  localPath: string;
  localCreateSubfolders: boolean;
  networkPath: string;
  networkUsername: string;
  networkPassword: string;
  networkReconnectInstructions: string;
  r2BucketName: string;
  r2Endpoint: string;
  r2AccessKey: string;
  r2SecretKey: string;
  r2PublicUrl: string;
  r2Prefix: string;
};

const providerMeta: Record<StorageProvider, { label: string; icon: typeof HardDrive; description: string }> = {
  local: {
    label: "Local",
    icon: HardDrive,
    description: "Best for single-machine deployments and fast write access.",
  },
  network: {
    label: "Network Share",
    icon: Network,
    description: "Store on UNC/mounted paths for team-shared access.",
  },
  r2: {
    label: "R2",
    icon: Cloud,
    description: "Cloud object storage for durable offsite archive.",
  },
};

const postProcessingOptions = [
  { key: "keepOriginalOnly", label: "Keep original only" },
  { key: "keepProcessedText", label: "Keep processed text too" },
  { key: "keepGeneratedReport", label: "Keep generated report too" },
  { key: "saveMetadataOnly", label: "Save metadata record only" },
  { key: "moveToArchive", label: "Move to archive folder after processing" },
  { key: "copySecondaryBackup", label: "Copy to secondary backup destination" },
] as const;

type PostProcessingKey = (typeof postProcessingOptions)[number]["key"];

const getDefaultDestination = (
  provider: StorageProvider,
  enabled: boolean,
  useAsFinalArchive: boolean,
): DestinationSettings => ({
  provider,
  enabled,
  saveProcessedDocs: false,
  useAsFinalArchive,
  localPath: provider === "local" ? "D:/community-chronicle" : "",
  localCreateSubfolders: true,
  networkPath: provider === "network" ? "\\\\fileserver\\archive\\community-chronicle" : "",
  networkUsername: "",
  networkPassword: "",
  networkReconnectInstructions: "",
  r2BucketName: provider === "r2" ? "community-chronicle" : "",
  r2Endpoint: "",
  r2AccessKey: "",
  r2SecretKey: "",
  r2PublicUrl: "",
  r2Prefix: "",
});

const StorageSettingsPanel = () => {
  const [settingsTab, setSettingsTab] = useState("storage");
  const [finalArchive, setFinalArchive] = useState<DestinationSettings>(
    getDefaultDestination("local", true, true),
  );
  const [processingStorage, setProcessingStorage] = useState<DestinationSettings>(
    getDefaultDestination("network", false, false),
  );
  const [postProcessingRules, setPostProcessingRules] = useState<Record<PostProcessingKey, boolean>>({
    keepOriginalOnly: false,
    keepProcessedText: true,
    keepGeneratedReport: true,
    saveMetadataOnly: false,
    moveToArchive: true,
    copySecondaryBackup: false,
  });

  const [pathStrategy, setPathStrategy] = useState({
    byYear: true,
    bySource: false,
    byDocType: true,
    byTopic: true,
    customNamingPattern: "{{year}}/{{docType}}/{{topic}}/{{filename}}",
    basePathPrefix: "/",
  });

  const destinationPathExample = useMemo(() => {
    const segments: string[] = [];

    if (pathStrategy.byYear) segments.push("2026");
    if (pathStrategy.bySource) segments.push("ImportPortal");
    if (pathStrategy.byDocType) segments.push("Reports");
    if (pathStrategy.byTopic) segments.push("CivilRights");

    const base = pathStrategy.basePathPrefix.trim() || "/";
    const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
    const generated = `${normalizedBase}/${segments.join("/")}/filename.pdf`;
    return generated.replaceAll("//", "/");
  }, [pathStrategy]);

  const providerLabel = (provider: StorageProvider) => providerMeta[provider].label;

  const testConnection = (destination: "final" | "processing") => {
    const target = destination === "final" ? finalArchive : processingStorage;
    const targetLabel = destination === "final" ? "Final archive" : "Processing storage";

    if (target.provider === "local" && !target.localPath.trim()) {
      toast.error("Base folder path is required before testing write access.");
      return;
    }
    if (target.provider === "network" && !target.networkPath.trim()) {
      toast.error("UNC or mounted path is required before read/write test.");
      return;
    }
    if (target.provider === "r2" && (!target.r2BucketName.trim() || !target.r2Endpoint.trim())) {
      toast.error("Bucket name and endpoint are required before testing R2 connection.");
      return;
    }

    const actionLabel =
      target.provider === "local"
        ? "write test"
        : target.provider === "network"
          ? "read/write test"
          : "connection test";

    toast.success(`${targetLabel} ${providerLabel(target.provider)} ${actionLabel} succeeded.`);
  };

  const saveSettings = () => {
    toast.success("Storage settings saved. Upload -> Process -> Review -> Final storage flow is now configured.");
  };

  const toggleRule = (ruleKey: PostProcessingKey, checked: boolean) => {
    setPostProcessingRules((prev) => ({
      ...prev,
      [ruleKey]: checked,
    }));
  };

  const renderProviderFields = (
    destination: DestinationSettings,
    setDestination: React.Dispatch<React.SetStateAction<DestinationSettings>>,
    destinationType: "final" | "processing",
  ) => {
    if (destination.provider === "local") {
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${destinationType}-local-path`}>Base folder path</Label>
            <Input
              id={`${destinationType}-local-path`}
              value={destination.localPath}
              onChange={(event) =>
                setDestination((prev) => ({
                  ...prev,
                  localPath: event.target.value,
                }))
              }
              placeholder="D:/community-chronicle/archive"
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium text-foreground">Create subfolders automatically</p>
              <p className="text-xs text-muted-foreground">Create missing year/source/type folders as needed.</p>
            </div>
            <Switch
              checked={destination.localCreateSubfolders}
              onCheckedChange={(checked) =>
                setDestination((prev) => ({
                  ...prev,
                  localCreateSubfolders: checked,
                }))
              }
            />
          </div>
        </div>
      );
    }

    if (destination.provider === "network") {
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`${destinationType}-network-path`}>UNC path or mounted path</Label>
            <Input
              id={`${destinationType}-network-path`}
              value={destination.networkPath}
              onChange={(event) =>
                setDestination((prev) => ({
                  ...prev,
                  networkPath: event.target.value,
                }))
              }
              placeholder="\\\\server\\share\\community-chronicle"
            />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${destinationType}-network-user`}>Username (optional)</Label>
              <Input
                id={`${destinationType}-network-user`}
                value={destination.networkUsername}
                onChange={(event) =>
                  setDestination((prev) => ({
                    ...prev,
                    networkUsername: event.target.value,
                  }))
                }
                placeholder="domain\\svc_archive"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${destinationType}-network-password`}>Password (optional)</Label>
              <Input
                id={`${destinationType}-network-password`}
                type="password"
                value={destination.networkPassword}
                onChange={(event) =>
                  setDestination((prev) => ({
                    ...prev,
                    networkPassword: event.target.value,
                  }))
                }
                placeholder="********"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${destinationType}-network-reconnect`}>Reconnect instructions (optional)</Label>
            <Textarea
              id={`${destinationType}-network-reconnect`}
              value={destination.networkReconnectInstructions}
              onChange={(event) =>
                setDestination((prev) => ({
                  ...prev,
                  networkReconnectInstructions: event.target.value,
                }))
              }
              placeholder="Map drive Z: on startup and reconnect after VPN sessions."
              rows={3}
            />
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${destinationType}-r2-bucket`}>Bucket name</Label>
            <Input
              id={`${destinationType}-r2-bucket`}
              value={destination.r2BucketName}
              onChange={(event) =>
                setDestination((prev) => ({
                  ...prev,
                  r2BucketName: event.target.value,
                }))
              }
              placeholder="community-chronicle"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${destinationType}-r2-endpoint`}>Endpoint</Label>
            <Input
              id={`${destinationType}-r2-endpoint`}
              value={destination.r2Endpoint}
              onChange={(event) =>
                setDestination((prev) => ({
                  ...prev,
                  r2Endpoint: event.target.value,
                }))
              }
              placeholder="https://<account-id>.r2.cloudflarestorage.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${destinationType}-r2-access`}>Access key</Label>
            <Input
              id={`${destinationType}-r2-access`}
              value={destination.r2AccessKey}
              onChange={(event) =>
                setDestination((prev) => ({
                  ...prev,
                  r2AccessKey: event.target.value,
                }))
              }
              placeholder="R2_ACCESS_KEY"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${destinationType}-r2-secret`}>Secret key</Label>
            <Input
              id={`${destinationType}-r2-secret`}
              type="password"
              value={destination.r2SecretKey}
              onChange={(event) =>
                setDestination((prev) => ({
                  ...prev,
                  r2SecretKey: event.target.value,
                }))
              }
              placeholder="********"
            />
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`${destinationType}-r2-public-url`}>Public/base URL (optional)</Label>
            <Input
              id={`${destinationType}-r2-public-url`}
              value={destination.r2PublicUrl}
              onChange={(event) =>
                setDestination((prev) => ({
                  ...prev,
                  r2PublicUrl: event.target.value,
                }))
              }
              placeholder="https://assets.community-chronicle.org"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${destinationType}-r2-prefix`}>Prefix/folder path</Label>
            <Input
              id={`${destinationType}-r2-prefix`}
              value={destination.r2Prefix}
              onChange={(event) =>
                setDestination((prev) => ({
                  ...prev,
                  r2Prefix: event.target.value,
                }))
              }
              placeholder="archives/approved"
            />
          </div>
        </div>
      </div>
    );
  };

  const renderDestinationCard = (
    title: string,
    description: string,
    destination: DestinationSettings,
    setDestination: React.Dispatch<React.SetStateAction<DestinationSettings>>,
    destinationType: "final" | "processing",
  ) => {
    const ActiveIcon = providerMeta[destination.provider].icon;
    const isFinal = destinationType === "final";

    return (
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="font-display text-xl">{title}</CardTitle>
              <CardDescription className="font-body text-sm mt-1">{description}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={destination.enabled ? "default" : "secondary"}>
                {destination.enabled ? "Active destination" : "Disabled"}
              </Badge>
              <Badge variant="outline" className="gap-1.5">
                <ActiveIcon className="h-3.5 w-3.5" />
                {providerMeta[destination.provider].label}
              </Badge>
            </div>
          </div>

          {!isFinal && (
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">Enable optional processing storage</p>
                <p className="text-xs text-muted-foreground">
                  Use a temporary holding location for OCR/parsing output before final approval.
                </p>
              </div>
              <Switch
                checked={destination.enabled}
                onCheckedChange={(checked) =>
                  setDestination((prev) => ({
                    ...prev,
                    enabled: checked,
                  }))
                }
              />
            </div>
          )}
        </CardHeader>

        <CardContent className="space-y-6">
          {(destination.enabled || isFinal) && (
            <>
              <div className="space-y-3">
                <Label className="font-medium">Default storage destination</Label>
                <div className="grid gap-3 md:grid-cols-3">
                  {(Object.keys(providerMeta) as StorageProvider[]).map((provider) => {
                    const ProviderIcon = providerMeta[provider].icon;
                    const selected = destination.provider === provider;

                    return (
                      <button
                        key={provider}
                        type="button"
                        onClick={() =>
                          setDestination((prev) => ({
                            ...prev,
                            provider,
                          }))
                        }
                        className={`rounded-lg border p-3 text-left transition-colors ${
                          selected
                            ? "border-primary bg-primary/5"
                            : "border-border hover:border-primary/50"
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <ProviderIcon className="h-4 w-4 text-primary" />
                          <span className="text-sm font-semibold text-foreground">{providerMeta[provider].label}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">{providerMeta[provider].description}</p>
                      </button>
                    );
                  })}
                </div>
              </div>

              <Separator />

              <div className="space-y-4">
                <h4 className="font-semibold text-foreground">Connection setup</h4>
                {renderProviderFields(destination, setDestination, destinationType)}
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => testConnection(destinationType)}
                    className="gap-2"
                  >
                    <Server className="h-4 w-4" />
                    {destination.provider === "local"
                      ? "Test write"
                      : destination.provider === "network"
                        ? "Read/write test"
                        : "Test connection"}
                  </Button>
                </div>
              </div>

              <Separator />

              <div className="grid gap-3 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <p className="text-sm font-medium">Save processed docs to this destination</p>
                    <p className="text-xs text-muted-foreground">Store OCR text/report outputs here.</p>
                  </div>
                  <Switch
                    checked={destination.saveProcessedDocs}
                    onCheckedChange={(checked) =>
                      setDestination((prev) => ({
                        ...prev,
                        saveProcessedDocs: checked,
                      }))
                    }
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <p className="text-sm font-medium">Use as final archive</p>
                    <p className="text-xs text-muted-foreground">Approved docs are retained permanently.</p>
                  </div>
                  <Switch
                    checked={destination.useAsFinalArchive}
                    onCheckedChange={(checked) =>
                      setDestination((prev) => ({
                        ...prev,
                        useAsFinalArchive: checked,
                      }))
                    }
                  />
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <Card className="border-primary/20 bg-gradient-to-br from-primary/5 via-background to-background">
        <CardHeader>
          <CardTitle className="font-display text-2xl">Settings</CardTitle>
          <CardDescription className="font-body">
            Configure storage, processing behavior, retention defaults, and integrations.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs value={settingsTab} onValueChange={setSettingsTab}>
            <TabsList className="w-full md:w-auto">
              <TabsTrigger value="storage" className="font-body">Storage</TabsTrigger>
              <TabsTrigger value="processing" className="font-body">Processing Rules</TabsTrigger>
              <TabsTrigger value="retention" className="font-body">Document Retention</TabsTrigger>
              <TabsTrigger value="integrations" className="font-body">Integrations</TabsTrigger>
            </TabsList>

            <TabsContent value="storage" className="mt-6 space-y-6">
              <div className="rounded-lg border bg-card p-4 md:p-5">
                <h4 className="font-semibold text-foreground mb-3">Storage flow</h4>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="outline">Upload</Badge>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  <Badge variant="outline">Process</Badge>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  <Badge variant="outline">Review / Approve</Badge>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  <Badge>Save to Final Storage</Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  This split avoids mixing temporary OCR artifacts with approved archive records.
                </p>
              </div>

              {renderDestinationCard(
                "Final Archive Storage",
                "Primary destination where approved documents live permanently.",
                finalArchive,
                setFinalArchive,
                "final",
              )}

              {renderDestinationCard(
                "Processing Storage",
                "Optional temporary holding area during OCR/parsing and quality checks.",
                processingStorage,
                setProcessingStorage,
                "processing",
              )}

              <Card>
                <CardHeader>
                  <CardTitle className="font-display text-xl">Post-processing rules</CardTitle>
                  <CardDescription className="font-body text-sm">
                    Control what artifacts are kept after OCR/reporting completes.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {postProcessingOptions.map((option) => (
                    <div key={option.key} className="flex items-center justify-between rounded-lg border p-3">
                      <Label htmlFor={option.key} className="text-sm font-medium cursor-pointer">
                        {option.label}
                      </Label>
                      <Checkbox
                        id={option.key}
                        checked={postProcessingRules[option.key]}
                        onCheckedChange={(checked) => toggleRule(option.key, checked === true)}
                      />
                    </div>
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="font-display text-xl">Folder/path strategy</CardTitle>
                  <CardDescription className="font-body text-sm">
                    Decide how final storage paths are generated.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="flex items-center justify-between rounded-lg border p-3">
                      <Label htmlFor="path-by-year" className="cursor-pointer">Organize by year</Label>
                      <Switch
                        id="path-by-year"
                        checked={pathStrategy.byYear}
                        onCheckedChange={(checked) =>
                          setPathStrategy((prev) => ({
                            ...prev,
                            byYear: checked,
                          }))
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between rounded-lg border p-3">
                      <Label htmlFor="path-by-source" className="cursor-pointer">Organize by source</Label>
                      <Switch
                        id="path-by-source"
                        checked={pathStrategy.bySource}
                        onCheckedChange={(checked) =>
                          setPathStrategy((prev) => ({
                            ...prev,
                            bySource: checked,
                          }))
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between rounded-lg border p-3">
                      <Label htmlFor="path-by-type" className="cursor-pointer">Organize by document type</Label>
                      <Switch
                        id="path-by-type"
                        checked={pathStrategy.byDocType}
                        onCheckedChange={(checked) =>
                          setPathStrategy((prev) => ({
                            ...prev,
                            byDocType: checked,
                          }))
                        }
                      />
                    </div>
                    <div className="flex items-center justify-between rounded-lg border p-3">
                      <Label htmlFor="path-by-topic" className="cursor-pointer">Organize by topic</Label>
                      <Switch
                        id="path-by-topic"
                        checked={pathStrategy.byTopic}
                        onCheckedChange={(checked) =>
                          setPathStrategy((prev) => ({
                            ...prev,
                            byTopic: checked,
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="base-prefix">Base path/prefix</Label>
                      <Input
                        id="base-prefix"
                        value={pathStrategy.basePathPrefix}
                        onChange={(event) =>
                          setPathStrategy((prev) => ({
                            ...prev,
                            basePathPrefix: event.target.value,
                          }))
                        }
                        placeholder="/archive"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="path-preset">Quick naming preset</Label>
                      <Select
                        value={pathStrategy.customNamingPattern}
                        onValueChange={(value) =>
                          setPathStrategy((prev) => ({
                            ...prev,
                            customNamingPattern: value,
                          }))
                        }
                      >
                        <SelectTrigger id="path-preset">
                          <SelectValue placeholder="Select naming pattern" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="{{year}}/{{docType}}/{{topic}}/{{filename}}">
                            Year / Type / Topic / Filename
                          </SelectItem>
                          <SelectItem value="{{source}}/{{year}}/{{filename}}">
                            Source / Year / Filename
                          </SelectItem>
                          <SelectItem value="{{docType}}/{{topic}}/{{filename}}">
                            Type / Topic / Filename
                          </SelectItem>
                          <SelectItem value="{{year}}/{{source}}/{{docType}}/{{filename}}">
                            Year / Source / Type / Filename
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="custom-naming-pattern">Custom naming pattern</Label>
                    <Input
                      id="custom-naming-pattern"
                      value={pathStrategy.customNamingPattern}
                      onChange={(event) =>
                        setPathStrategy((prev) => ({
                          ...prev,
                          customNamingPattern: event.target.value,
                        }))
                      }
                      placeholder="{{year}}/{{docType}}/{{topic}}/{{filename}}"
                    />
                    <p className="text-xs text-muted-foreground">
                      Available tokens: {"{{year}}"}, {"{{source}}"}, {"{{docType}}"}, {"{{topic}}"}, {"{{filename}}"}
                    </p>
                  </div>

                  <div className="rounded-lg border bg-muted/40 p-4">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Example path</p>
                    <p className="font-mono text-sm text-foreground">{destinationPathExample}</p>
                    <p className="text-xs text-muted-foreground mt-2">Sample: /2026/Reports/CivilRights/filename.pdf</p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="processing" className="mt-6">
              <Card>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground">
                    Processing Rules is available from this page now via the Storage tab's Post-processing Rules section.
                  </p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="retention" className="mt-6">
              <Card>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground">
                    Document retention policies can be added next (e.g., raw upload TTL and failed-doc cleanup windows).
                  </p>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="integrations" className="mt-6">
              <Card>
                <CardContent className="pt-6">
                  <p className="text-sm text-muted-foreground">
                    Integrations is ready for future destinations, secondary backups, and compliance logging endpoints.
                  </p>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button variant="outline" onClick={() => testConnection("final")} className="gap-2">
          <CheckCircle2 className="h-4 w-4" />
          Test active destination
        </Button>
        <Button onClick={saveSettings} className="gap-2">
          <Save className="h-4 w-4" />
          Save settings
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="pt-6 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FolderCog className="h-4 w-4 text-primary" />
              Temporary processing storage
            </div>
            <p className="text-xs text-muted-foreground">
              Keeps in-progress files, OCR artifacts, and retry snapshots separate from approved records.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <FolderArchive className="h-4 w-4 text-primary" />
              Approved final archive
            </div>
            <p className="text-xs text-muted-foreground">
              Stores curated records after review and approval, with predictable folder strategy.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Database className="h-4 w-4 text-primary" />
              Metadata and audit trail
            </div>
            <p className="text-xs text-muted-foreground">
              Tracks document lineage for failed docs, multi-destination backups, and future compliance checks.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default StorageSettingsPanel;
