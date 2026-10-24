// Next.js 16은 Node가 실행 중에 제공하는 URLPatternInput이라는 타입 별칭을 참조한다.
// 그런데 현재 Node 타입 패키지(@types/node)에는 구성 타입만 있고 이 별칭이 빠져 있어 타입 검사가 실패한다.
// 그 빈자리를 채우려고 여기서 직접 선언한다. 실행 코드에는 영향이 없는 타입 전용 파일이다.
type URLPatternInput = string | URLPatternInit;

interface URLPatternOptions {
  ignoreCase?: boolean;
}
