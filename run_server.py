"""서버 실행 진입점.

    python run_server.py

사내망 접속을 위해 기본 바인딩은 0.0.0.0 이다.
같은 망의 다른 PC에서는 http://<이 PC의 사설 IP>:8000 으로 접속한다.
(IP 확인: 명령 프롬프트에서 ipconfig → IPv4 주소)
"""

from __future__ import annotations

import socket

import uvicorn

import config


def local_ip() -> str:
    """사내망에서 접속할 때 쓸 이 PC의 IPv4 주소를 추정한다."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # 실제로 패킷을 보내지는 않는다
        return s.getsockname()[0]
    except Exception:  # noqa: BLE001
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    print("=" * 62)
    print(" 학교 매뉴얼 RAG 챗봇")
    for k, v in config.describe().items():
        print(f"   {k:<16}: {v}")
    warn = config.check_api_key()
    if warn:
        print(f"\n   [경고] {warn}")

    print(f"\n   이 PC        : http://localhost:{config.PORT}")
    print(f"   사내망 접속  : http://{local_ip()}:{config.PORT}")
    print(f"   API 문서     : http://localhost:{config.PORT}/docs")
    print("=" * 62)

    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT, reload=False)
