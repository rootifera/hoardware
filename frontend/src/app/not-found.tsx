import { SearchX } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <SearchX className="size-10 text-muted-foreground" />
      <h1 className="text-lg font-semibold">Page not found</h1>
      <Button variant="outline" render={<Link href="/" />}>
        Back to inventory
      </Button>
    </div>
  );
}
