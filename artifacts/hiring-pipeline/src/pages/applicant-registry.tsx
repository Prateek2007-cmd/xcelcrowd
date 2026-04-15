import { useState } from "react";
import { Link } from "wouter";
import { Search, ChevronRight } from "lucide-react";

import { useListApplicants } from "@workspace/api-client-react";

import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { format } from "date-fns";

export default function ApplicantRegistry() {
  const { data: applicants, isLoading } = useListApplicants();
  const [search, setSearch] = useState("");

  const filteredApplicants = applicants?.filter(
    (a) =>
      a.name.toLowerCase().includes(search.toLowerCase()) ||
      a.email.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">Applicant Registry</h2>
          <p className="text-muted-foreground mt-1">
            Global directory of all applicants in the system.
          </p>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search applicants by name or email..."
            className="pl-9 max-w-md bg-card/50"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="border rounded-md bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="bg-muted/50 text-muted-foreground border-b font-medium">
                <tr>
                  <th className="px-4 py-3">Applicant</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Registered At</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                      Loading applicants...
                    </td>
                  </tr>
                ) : filteredApplicants?.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                      No applicants found.
                    </td>
                  </tr>
                ) : (
                  filteredApplicants?.map((applicant) => (
                    <tr key={applicant.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                      <td className="px-4 py-3 font-medium flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">
                          {applicant.name.charAt(0).toUpperCase()}
                        </div>
                        {applicant.name}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                        {applicant.email}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {format(new Date(applicant.createdAt), "MMM d, yyyy HH:mm")}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link href={`/applicants/${applicant.id}`}>
                          <Button variant="ghost" size="sm" className="h-8 group">
                            Details
                            <ChevronRight className="ml-1 h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </Layout>
  );
}
