-- ─────────────────────────────────────────────────────────────────────────────
-- 2026-11-07 변경: 문서 전체 임베딩 검색 함수 추가
--
-- 배경: 지금까지는 질문 낱말이 선택한 장의 핵심어 사전에 없으면 그 장의 본문을 검색하지 않고
--       다른 장의 "사전만" 문자열로 비교해 안내했다. 사용자가 사전과 다른 표현을 쓰면
--       답이 있어도 "찾지 못함"이 나오는 문제가 있었다.
-- 변경: 운영 중인 문서 전체를 대상으로 질문 벡터와 가장 가까운 청크를 찾는 함수를 추가한다.
--       서버(api/ask/route.ts)는 선택한 장에서 근거를 못 찾았을 때 이 함수로
--       "가장 가까운 청크가 어느 장에 있는지"를 알아내 그 장을 안내한다.
-- 적용: Supabase SQL Editor에서 이 파일을 한 번 실행한다(schema.sql에도 같은 함수가 들어 있다).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.match_document_chunks(query_embedding vector, target_documents uuid[], match_count integer default 5)
returns table (id uuid, chapter_id uuid, similarity real)
language sql stable
as $$
  select c.id, c.chapter_id,
         (1 - (e.embedding <=> query_embedding))::real as similarity
  from public.chunks c
  join public.embeddings e on e.chunk_id = c.id
  where c.document_id = any(target_documents)
  order by e.embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function public.match_document_chunks(vector, uuid[], integer) to service_role;
