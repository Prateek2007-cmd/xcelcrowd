import { useState } from "react";
import { useRoute, Link } from "wouter";
import {
  useGetJob,
  useReplayPipeline,
  getReplayPipelineQueryKey,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Clock, RefreshCw, Activity } from "lucide-react";

function statusColor(status: string) {
  switch (status) {
    case "ACTIVE":
      return "bg-emerald-500/15 text-emerald-700 border-emerald-500/25";
    case "PENDING_ACKNOWLEDGMENT":
      return "bg-orange-500/15 text-orange-700 border-orange-500/25";
    case "WAITLIST":
      return "bg-amber-500/15 text-amber-700 border-amber-500/25";
    case "INACTIVE":
      return "bg-gray-500/15 text-gray-600 border-gray-500/25";
    default:
      return "bg-gray-100 text-gray-600 border-gray-200";
  }
}

function EventBadge({ event }: { event: string }) {
  const map: Record<string, string> = {
    APPLIED: "bg-blue-500/15 text-blue-700 border-blue-500/25",
    PROMOTED: "bg-purple-500/15 text-purple-700 border-purple-500/25",
    ACKNOWLEDGED: "bg-emerald-500/15 text-emerald-700 border-emerald-500/25",
    WITHDRAWN: "bg-gray-500/15 text-gray-600 border-gray-500/25",
    DECAY_TRIGGERED: "bg-red-500/15 text-red-700 border-red-500/25",
    PENALTY_APPLIED: "bg-orange-500/15 text-orange-700 border-orange-500/25",
    STATUS_CHANGED: "bg-slate-500/15 text-slate-700 border-slate-500/25",
  };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium border ${map[event] ?? "bg-gray-100 text-gray-600"}`}>
      {event.replace(/_/g, " ")}
    </span>
  );
}

export default function PipelineReplay() {
  const [, params] = useRoute("/pipeline/:jobId/replay");
  const jobId = parseInt(params?.jobId ?? "0");

  const [asOf, setAsOf] = useState<string>(() => {
    const d = new Date();
    d.setSeconds(0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [queryAsOf, setQueryAsOf] = useState<string | undefined>(undefined);

  const { data: job } = useGetJob(jobId, { query: { enabled: !!jobId } });
  const { data: replay, isLoading } = useReplayPipeline(
    jobId,
    { asOf: queryAsOf },
    { query: { enabled: !!jobId && !!queryAsOf, queryKey: getReplayPipelineQueryKey(jobId, { asOf: queryAsOf }) } }
  );

  function handleReplay() {
    const d = new Date(asOf);
    setQueryAsOf(d.toISOString());
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border bg-card/50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
          <Link href={`/jobs/${jobId}`}>
            <Button variant="ghost" size="sm" className="gap-2">
              <ArrowLeft className="w-4 h-4" />
              Back to Pipeline
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4 text-muted-foreground" />
            <span className="text-lg font-semibold">
              Pipeline Replay
            </span>
            {job && (
              <span className="text-muted-foreground text-sm">— {job.title}</span>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Select Timestamp
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Choose a point in time to see what the pipeline looked like then. The system will reconstruct state from audit logs.
            </p>
            <div className="flex items-center gap-3">
              <Input
                type="datetime-local"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                className="w-64"
              />
              <Button onClick={handleReplay} className="gap-2">
                <RefreshCw className="w-4 h-4" />
                Replay at this time
              </Button>
            </div>
          </CardContent>
        </Card>

        {isLoading && (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">
            Reconstructing pipeline state...
          </div>
        )}

        {replay && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                    Active Applicants
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {replay.activeApplicants.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No active applicants at this time.</p>
                  ) : (
                    <div className="space-y-2">
                      {replay.activeApplicants.map((entry) => (
                        <div
                          key={entry.applicationId}
                          className="flex items-center justify-between py-2 border-b border-border last:border-0"
                        >
                          <span className="text-sm font-medium">{entry.applicantName}</span>
                          <Badge className={statusColor(entry.status)}>
                            {entry.status.replace(/_/g, " ")}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
                    Waitlist
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {replay.waitlistApplicants.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No waitlist at this time.</p>
                  ) : (
                    <div className="space-y-2">
                      {replay.waitlistApplicants.map((entry, i) => (
                        <div
                          key={entry.applicationId}
                          className="flex items-center justify-between py-2 border-b border-border last:border-0"
                        >
                          <div className="flex items-center gap-3">
                            <span className="text-xs text-muted-foreground w-6 text-right">#{i + 1}</span>
                            <span className="text-sm font-medium">{entry.applicantName}</span>
                          </div>
                          <Badge className={statusColor(entry.status)}>
                            {entry.status}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Activity className="w-4 h-4" />
                  Events Log at {new Date(replay.asOf).toLocaleString()}
                  <span className="ml-auto text-xs text-muted-foreground font-normal">
                    {replay.events.length} events
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {replay.events.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No events recorded up to this point.</p>
                ) : (
                  <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                    {[...replay.events].reverse().map((event) => (
                      <div
                        key={event.id}
                        className="flex items-start gap-4 py-2.5 border-b border-border last:border-0"
                      >
                        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap pt-0.5 w-32">
                          {new Date(event.createdAt).toLocaleTimeString()}
                        </span>
                        <EventBadge event={event.eventType} />
                        <div className="flex-1 min-w-0">
                          {event.fromStatus && (
                            <span className="text-xs text-muted-foreground">
                              {event.fromStatus} → {event.toStatus}
                            </span>
                          )}
                          {!event.fromStatus && (
                            <span className="text-xs text-muted-foreground">{event.toStatus}</span>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground">app #{event.applicationId}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}

        {!queryAsOf && !isLoading && (
          <div className="text-center py-16 text-muted-foreground text-sm">
            Select a timestamp above and click Replay to reconstruct the pipeline state.
          </div>
        )}
      </div>
    </div>
  );
}
