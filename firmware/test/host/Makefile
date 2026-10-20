# Host-side unit tests for the portable firmware core (no ESP32 toolchain needed).
test: test_core
	./test_core
test_core: test_core.cpp ../../lib/insole_core/insole_core.h
	g++ -std=c++17 -Wall -Wextra -O1 -o test_core test_core.cpp
clean:
	rm -f test_core
