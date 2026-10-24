实验名称：基于 Spring MVC 的用户登录模块
课程名称：Java EE 程序设计
学期：2026/2027(1)
姓名：测试用户
学号：2026000001
班级：软工2402
任课教师：测试教师
提交日期：2026.10.24

一、实验目的
1. 掌握 Spring MVC 的请求处理流程与核心组件协作方式。
2. 能够独立完成 Controller、Service、视图页面和配置文件的编写与联调。
3. 能够定位并修复部署、映射、参数绑定中的常见错误。

二、实验环境
Windows 11、JDK 17、Tomcat 10、Spring Framework 6、Eclipse IDE。

三、实验内容与要求
实现用户登录模块：用户在 login.jsp 输入用户名和密码，Controller 接收请求，Service 校验后跳转成功页或返回失败提示。要求使用注解 Controller，并补充一个参数绑定示例。

任务1 搭建工程与依赖
创建 Maven Web 工程，配置 Spring MVC 依赖与 web.xml。

任务2 编写登录控制器与业务层
实现 LoginController、UserService，完成参数接收、校验与视图跳转。

任务3 部署运行与问题排查
部署到 Tomcat，验证成功和失败路径，记录至少两个问题及解决过程。

四、实验原理
DispatcherServlet 接收请求，HandlerMapping 找到 Controller，Controller 返回 ModelAndView，ViewResolver 解析视图。

五、实验总结
总结 Spring MVC 的分层协作方式、调试经验与不足。
