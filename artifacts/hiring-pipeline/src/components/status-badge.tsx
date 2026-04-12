import { Badge } from "@/components/ui/badge";

export function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "ACTIVE":
      return (
        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 uppercase tracking-wider font-mono text-xs">
          ACTIVE
        </Badge>
      );
    case "WAITLIST":
      return (
        <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/20 uppercase tracking-wider font-mono text-xs">
          WAITLIST
        </Badge>
      );
    case "PENDING_ACKNOWLEDGMENT":
      return (
        <Badge variant="outline" className="bg-red-500/10 text-red-500 border-red-500/20 animate-pulse-red uppercase tracking-wider font-mono text-xs">
          PENDING ACK
        </Badge>
      );
    case "INACTIVE":
      return (
        <Badge variant="outline" className="bg-gray-500/10 text-gray-400 border-gray-500/20 uppercase tracking-wider font-mono text-xs">
          INACTIVE
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="uppercase tracking-wider font-mono text-xs">
          {status}
        </Badge>
      );
  }
}
