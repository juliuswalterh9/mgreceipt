-- MySQL 서버에서 실행하세요 (로컬 root 또는 GRANT 권한이 있는 계정).
-- DBeaver 등 클라이언트 설정: scripts/dbeaver-mysql-connection.txt 참고
-- 오류: Host '10.14.100.70' is not allowed to connect to this MySQL server
-- → 클라이언트 IP(10.14.100.70)에 대해 user@host 권한이 없을 때 발생합니다.
--
-- 아래 YOUR_USER, YOUR_PASSWORD, YOUR_DB 를 .env 의 DATABASE_URL 과 맞게 바꿉니다.

-- ---------------------------------------------------------------------------
-- 방법 1) 해당 IP만 허용 (권장)
-- ---------------------------------------------------------------------------
-- CREATE USER 'YOUR_USER'@'10.14.100.70' IDENTIFIED BY 'YOUR_PASSWORD';
-- GRANT ALL PRIVILEGES ON YOUR_DB.* TO 'YOUR_USER'@'10.14.100.70';
-- FLUSH PRIVILEGES;

-- 이미 같은 이름 사용자가 있으면 CREATE 대신:
-- CREATE USER IF NOT EXISTS 'YOUR_USER'@'10.14.100.70' IDENTIFIED BY 'YOUR_PASSWORD';

-- ---------------------------------------------------------------------------
-- 방법 2) 기존 계정에 호스트 한 줄만 추가 (비밀번호는 기존과 동일하게 맞춤)
-- ---------------------------------------------------------------------------
-- 예: 로컬만 있던 사용자에 원격 IP 추가
-- CREATE USER 'YOUR_USER'@'10.14.100.70' IDENTIFIED BY 'YOUR_PASSWORD';
-- GRANT ALL PRIVILEGES ON YOUR_DB.* TO 'YOUR_USER'@'10.14.100.70';
-- FLUSH PRIVILEGES;

-- ---------------------------------------------------------------------------
-- 방법 3) 대역 허용 (여러 대에서 접속할 때, 보안은 방법 1보다 느슨함)
-- ---------------------------------------------------------------------------
-- CREATE USER 'YOUR_USER'@'10.14.%' IDENTIFIED BY 'YOUR_PASSWORD';
-- GRANT ALL PRIVILEGES ON YOUR_DB.* TO 'YOUR_USER'@'10.14.%';
-- FLUSH PRIVILEGES;

-- ---------------------------------------------------------------------------
-- 확인
-- ---------------------------------------------------------------------------
-- SELECT user, host FROM mysql.user WHERE user = 'YOUR_USER';

-- ---------------------------------------------------------------------------
-- 아래 블록: 값만 바꾼 뒤 MySQL에서 실행 (주석 제거)
-- ---------------------------------------------------------------------------
/*
CREATE USER 'YOUR_USER'@'10.14.100.70' IDENTIFIED BY 'YOUR_PASSWORD';
GRANT ALL PRIVILEGES ON YOUR_DB.* TO 'YOUR_USER'@'10.14.100.70';
FLUSH PRIVILEGES;
*/
