/* Read-only display probe in the fresh task-owned Wine desktop. */
typedef unsigned int DWORD;
typedef void *HANDLE;
#define API __declspec(dllimport) __stdcall
API HANDLE GetStdHandle(DWORD);
API int WriteFile(HANDLE,const void *,DWORD,DWORD *,void *);
API void ExitProcess(DWORD);
API HANDLE GetDC(HANDLE);
API int ReleaseDC(HANDLE,HANDLE);
API int GetDeviceCaps(HANDLE,int);
API unsigned int GetSystemPaletteEntries(HANDLE,unsigned int,unsigned int,void *);
static char output[4096];
static unsigned char palette[1024];
static unsigned int length;
static HANDLE stdout_handle;
static void hex(DWORD value,unsigned int digits) {
    static const char alphabet[]="0123456789abcdef";
    while(digits){digits--;output[length++]=alphabet[(value>>(digits*4))&15];}
}
static void flush(void) {
    DWORD written=0;
    if(!WriteFile(stdout_handle,output,length,&written,0)||written!=length)ExitProcess(2);
    length=0;
}
void mainCRTStartup(void) {
    stdout_handle=GetStdHandle((DWORD)-11);
    HANDLE dc=GetDC(0);
    if(!dc)ExitProcess(3);
    for(unsigned int index=0;index<=120;index++) {
        output[length++]='G';output[length++]=' ';hex(index,8);output[length++]=' ';hex(GetDeviceCaps(dc,index),8);output[length++]='\n';flush();
    }
    unsigned int count=GetSystemPaletteEntries(dc,0,256,palette);
    if(count>256)ExitProcess(4);
    output[length++]='P';output[length++]=' ';hex(count,8);
    for(unsigned int i=0;i<count*4;i++){output[length++]=' ';hex(palette[i],2);}
    output[length++]='\n';flush();
    if(!ReleaseDC(0,dc))ExitProcess(5);
    ExitProcess(0);
}
