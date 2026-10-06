/* Read-only reference probe. No file, registry, network or user-data imports.
 * Every locale query sets LOCALE_NOUSEROVERRIDE, returning canonical data.
 * Build without a CRT; only the seven declared kernel32 functions are imported.
 */
typedef unsigned int DWORD;
typedef unsigned short WCHAR;
typedef void *HANDLE;
#define API __declspec(dllimport) __stdcall
API int GetLocaleInfoW(DWORD, DWORD, WCHAR *, int);
API int GetLocaleInfoA(DWORD, DWORD, char *, int);
API HANDLE GetStdHandle(DWORD);
API int WriteFile(HANDLE, const void *, DWORD, DWORD *, void *);
API DWORD GetACP(void);
API DWORD GetLastError(void);
API void ExitProcess(DWORD);
static WCHAR words[2048];
static char ansi[8192];
static char output[32768];
static unsigned int length;
static HANDLE stdout_handle;
static void hex(DWORD value, unsigned int digits) {
    static const char alphabet[]="0123456789abcdef";
    while(digits) {digits--;output[length++]=alphabet[(value>>(digits*4))&15];}
}
static void flush(void) {
    DWORD written=0;
    if(!WriteFile(stdout_handle,output,length,&written,0)||written!=length) ExitProcess(2);
    length=0;
}
static void query(DWORD locale,DWORD kind) {
    static const char modes[]={'W','A','C','N','D'};
    for(int mode=0;mode<5;mode++) {
        int wide=mode==0||mode==3;
        DWORD flags=0x80000000u|(mode==2?0x40000000u:0)|(mode>=3?0x20000000u:0);
        int count=wide?GetLocaleInfoW(locale,kind|flags,words,2048):GetLocaleInfoA(locale,kind|flags,ansi,8192);
        DWORD error=count?0:GetLastError();
        if(count<0||count>(wide?2048:8192))ExitProcess(3);
        output[length++]=modes[mode];output[length++]=' ';hex(locale,8);output[length++]=' ';hex(kind,8);output[length++]=' ';hex(count,8);output[length++]=' ';hex(error,8);
        for(int i=0;i<count;i++){output[length++]=' ';hex(wide?words[i]:(unsigned char)ansi[i],wide?4:2);}
        output[length++]='\n';flush();
    }
}
void mainCRTStartup(void) {
    static const DWORD locales[]={0x0409,0x0411,0x0804};
    stdout_handle=GetStdHandle((DWORD)-11);
    output[length++]='#';output[length++]=' ';hex(GetACP(),8);output[length++]='\n';flush();
    for(unsigned int i=0;i<3;i++) {
        for(DWORD type=1;type<=0xa8;type++)query(locales[i],type);
        for(DWORD type=0x1001;type<=0x1035;type++)query(locales[i],type);
    }
    ExitProcess(0);
}
