// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/documents/upload-url — PDF를 브라우저에서 Storage로 "직접" 올리기 위한 서명된 업로드 주소 발급(관리자 전용)
//
// 배경(2026-11-08): 예전에는 PDF가 브라우저 → Vercel 서버 함수 → Supabase Storage 순서로 서버 함수를 거쳤다.
// Vercel 서버 함수는 요청 본문을 4.5MB까지만 받으므로, 그보다 큰 편람 PDF는 Storage에 닿기도 전에
// "Request Entity Too Large"(413, 평문)로 거절됐고 화면에는 "… is not valid JSON"으로 보였다.
// 지금은 서버가 "이 경로에 한 번 올려도 된다"는 서명된 주소(토큰)만 만들어 주고,
// 브라우저가 그 주소로 Storage에 바로 올린다(supabase-js의 uploadToSignedUrl). 파일이 Vercel을 거치지 않으므로 크기 제한이 없다.
// 서명된 주소는 2시간 동안, 그 경로 하나에만 유효하다. 다른 경로나 다른 버킷에는 쓸 수 없다.
// 올린 뒤에는 POST /api/admin/documents 가 파일이 실제로 있는지 확인하고 문서 행을 만든다.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from "node:crypto";
import { errorResponse, requireAdmin } from "@/lib/auth";
import { serviceSupabase } from "@/lib/supabase";

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    // 경로는 "<무작위 id>/source.pdf". 문서 행은 아직 없으므로 문서 id 대신 무작위 폴더 이름을 쓴다.
    // 업로드가 중간에 실패해도 DB에는 아무것도 남지 않고, Storage에 빈 폴더만 남을 뿐이다.
    const path = `${randomUUID()}/source.pdf`;
    const { data, error } = await serviceSupabase().storage.from("personnel-pdfs").createSignedUploadUrl(path);
    if (error) throw error;
    return Response.json({ path: data.path, token: data.token });
  } catch (error) {
    return errorResponse(error);
  }
}
