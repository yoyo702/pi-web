import { NextRequest, NextResponse } from "next/server";
import { validateGitCwd } from "@/lib/git-request";
import { checkoutBranch, createBranch, deleteBranch, getBranches } from "@/lib/git-changes";
import { errorResponse } from "@/lib/http-error";

export async function GET(request: NextRequest) {
  try {
    const cwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const invalid = await validateGitCwd(cwd);
    if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });
    return NextResponse.json(await getBranches(cwd));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as {
      cwd?: string;
      action?: "checkout" | "create" | "delete";
      name?: string;
      startPoint?: string;
      checkout?: boolean;
      force?: boolean;
    };
    const invalid = await validateGitCwd(body.cwd);
    if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });

    const cwd = body.cwd as string;
    const name = body.name?.trim() ?? "";
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

    switch (body.action) {
      case "checkout":
        return NextResponse.json(await checkoutBranch(cwd, name));
      case "create":
        return NextResponse.json(await createBranch(cwd, name, {
          startPoint: body.startPoint,
          checkout: body.checkout,
        }));
      case "delete":
        return NextResponse.json(await deleteBranch(cwd, name, body.force === true));
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
